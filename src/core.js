/* MHXX 3DS save merger core.
 *
 * This module is deliberately dependency-light: it uses only the vendored
 * fflate build for zlib.  It can run in a browser ES module or in Node.
 */

import { unzlibSync, zlibSync } from '../vendor/fflate.mjs';

export const SAVE_SIZE = 4_726_152;
const PALICO_BASE_OFFSET = 0x23BB6;
export const PALICO_SIZE = 324;
export const PALICO_SLOTS = 84;
const EVENT_SLOT_SIZE = 0x1400;
// Each event slot is: u32 event id, u32 ARC size, then the ARC.  The first
// slot starts at 0xF874; its ARC starts at 0xF87C.
const GLOBAL_EVENT_BASE = 0xF874;
const EVENT_SLOT_HEADER = 8;

// Header fields that differ between a save with downloaded event quests and
// one without.  The donor save uses these as the DLC event-data descriptor.
const DLC_HEADER_FIELDS = [0x154, 0x298];
const DLC_HEADER_BYTES = 8;
// The global event-quest metadata table discovered in a working donor save.
const DLC_EVENT_TABLE_OFFSET = 0x10FC74;
const DLC_EVENT_TABLE_SIZE = 0x14800;
// Event-quest availability flags for the lower-rank event list.
const DLC_EVENT_FLAGS_OFFSET = 0xB263;
const DLC_EVENT_FLAGS_SIZE = 0xB0;
// 0xB27B..0xB27F are global console settings (3D depth/enable, Circle Pad),
// not DLC event data.  The flag block above is broad enough to cover them,
// so they must be restored from the target after copying donor flags.
const DLC_GLOBAL_SETTINGS_OFFSET = 0xB27B;
const DLC_GLOBAL_SETTINGS_SIZE = 5;

const CAT_NAME_OFFSET = 0x00;
const CAT_NAME_SIZE = 0x20;
const CAT_SHOUT_OFFSET = 0x60;
const CAT_SHOUT_SIZE = 0x3C;
const CAT_OWNER_OFFSET = 0x9C;
const CAT_OWNER_SIZE = 0x20;

// The official MHXX save editor clears these six bytes when importing a
// .catzx.  They describe the cat's equipped Palico gear.  A cat imported from
// a donor save can reference gear that is not in the target player's Palico
// equipment box; selecting such a cat in-game crashes.  Keep them safe.
const CAT_EQUIP_OFFSET = 0x100;
const PALICO_EQUIPMENT_OFFSET = 0x17C2E;
const PALICO_EQUIPMENT_SIZE = 36;
const PALICO_EQUIPMENT_SLOTS = 1000;
const PALICO_EQUIPMENT_WEAPON = 22;
// A basic Palico weapon record (type 22, ID 1), copied from the source save.
// Used only when the target has neither an existing cat weapon nor any
// weapon-type item in its Palico equipment box.
const DEFAULT_PALICO_WEAPON = new Uint8Array([
  0x16, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

const ARC_HEADER_SIZE = 0xC;
const ARC_RECORD_SIZE = 0x50;
const ARC_NAME_SIZE = 0x40;
const COMPRESSED_FLAG = 0x40000000;
const SIZE_MASK = 0x3FFFFFFF;

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('expected ArrayBuffer or Uint8Array');
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function setU16(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
}

function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function setU32(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
  bytes[offset + 2] = (value >>> 16) & 0xFF;
  bytes[offset + 3] = (value >>> 24) & 0xFF;
}

function align(value, alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}

function cString(bytes, offset, length) {
  const end = Math.min(bytes.length, offset + length);
  let stop = offset;
  while (stop < end && bytes[stop] !== 0) stop++;
  return utf8Decoder.decode(bytes.subarray(offset, stop));
}

function encodeCString(text, length) {
  const encoded = utf8Encoder.encode(String(text));
  if (encoded.includes(0)) throw new Error('text contains NUL');
  if (encoded.length >= length) {
    throw new Error(`text needs ${encoded.length} bytes, field only has ${length - 1}`);
  }
  return encoded;
}

function writeCString(bytes, offset, length, text) {
  const encoded = encodeCString(text, length);
  bytes.fill(0, offset, offset + length);
  bytes.set(encoded, offset);
}

function allZero(bytes, start, end) {
  if (start < 0 || end > bytes.length || start >= end) return false;
  for (let i = start; i < end; i++) if (bytes[i] !== 0) return false;
  return true;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function startsWith(bytes, offset, signature) {
  if (offset < 0 || offset + signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* ARC                                                                        */
/* -------------------------------------------------------------------------- */

/** Parse an ARC whose record data offsets are relative to the ARC start.
 * This is the form used inside MHXX save files. */
export function parseArcAt(source, offset, limit = source.length) {
  const bytes = bytesOf(source);
  if (!startsWith(bytes, offset, [0x41, 0x52, 0x43, 0x00])) {
    throw new Error(`ARC signature not found at 0x${offset.toString(16)}`);
  }
  if (offset + ARC_HEADER_SIZE > bytes.length) throw new Error('truncated ARC header');
  const unknown = u16(bytes, offset + 4);
  const count = u16(bytes, offset + 6);
  const unknown2 = u32(bytes, offset + 8);
  if (count === 0 || count > 512) throw new Error(`unreasonable ARC record count ${count}`);
  const tableEnd = offset + ARC_HEADER_SIZE + count * ARC_RECORD_SIZE;
  if (tableEnd > limit || tableEnd > bytes.length) throw new Error('ARC record table exceeds limit');

  const records = [];
  let end = tableEnd;
  for (let i = 0; i < count; i++) {
    const tableOffset = offset + ARC_HEADER_SIZE + i * ARC_RECORD_SIZE;
    const nameEnd = tableOffset + ARC_NAME_SIZE;
    let nameStop = tableOffset;
    while (nameStop < nameEnd && bytes[nameStop] !== 0) nameStop++;
    const name = utf8Decoder.decode(bytes.subarray(tableOffset, nameStop));
    const typeHash = u32(bytes, tableOffset + 0x40);
    const compressedSize = u32(bytes, tableOffset + 0x44);
    const uncompressedRaw = u32(bytes, tableOffset + 0x48);
    const dataOffset = u32(bytes, tableOffset + 0x4C);
    const absoluteData = offset + dataOffset;
    const absoluteEnd = absoluteData + compressedSize;
    if (absoluteData < offset || absoluteEnd > limit || absoluteEnd > bytes.length) {
      throw new Error(`ARC record ${i} data out of range`);
    }
    if (compressedSize > 0x01000000) throw new Error(`ARC record ${i} too large`);
    const compressed = (uncompressedRaw & COMPRESSED_FLAG) !== 0;
    const compressedData = bytes.subarray(absoluteData, absoluteEnd);
    let data;
    try {
      data = compressed ? unzlibSync(compressedData) : compressedData;
    } catch (error) {
      throw new Error(`ARC record ${i} (${name}) zlib error: ${error.message}`);
    }
    const expectedSize = uncompressedRaw & SIZE_MASK;
    if (data.length !== expectedSize) {
      throw new Error(`ARC record ${i} (${name}) size ${data.length} != ${expectedSize}`);
    }
    records.push({
      index: i,
      name,
      typeHash,
      compressedSize,
      uncompressedSizeRaw: uncompressedRaw,
      dataOffset,
      data: new Uint8Array(data), // copy so callers can modify safely
    });
    end = Math.max(end, absoluteEnd);
  }
  return {
    offset,
    unknown,
    unknown2,
    count,
    header: bytes.slice(offset, offset + ARC_HEADER_SIZE),
    records,
    end,
    rawSize: end - offset,
  };
}

export function buildArc(source, arc, replacements = new Map(), level = 9) {
  const records = arc.records;
  const dataStart = align(ARC_HEADER_SIZE + records.length * ARC_RECORD_SIZE, 0x20);
  const compressed = [];
  let cursor = dataStart;
  for (const record of records) {
    const plain = replacements.has(record.name) ? replacements.get(record.name) : record.data;
    const z = zlibSync(plain, { level });
    compressed.push({ record, z, plainSize: plain.length, offset: cursor });
    cursor += z.length;
  }
  const output = new Uint8Array(cursor);
  output.set(arc.header, 0);
  setU32(output, 8, arc.unknown2);
  for (const item of compressed) {
    const tableOffset = ARC_HEADER_SIZE + item.record.index * ARC_RECORD_SIZE;
    const name = utf8Encoder.encode(item.record.name);
    if (name.length >= ARC_NAME_SIZE) throw new Error(`ARC record name too long: ${item.record.name}`);
    output.fill(0, tableOffset, tableOffset + ARC_NAME_SIZE);
    output.set(name, tableOffset);
    setU32(output, tableOffset + 0x40, item.record.typeHash);
    setU32(output, tableOffset + 0x44, item.z.length);
    setU32(output, tableOffset + 0x48, COMPRESSED_FLAG | item.plainSize);
    setU32(output, tableOffset + 0x4C, item.offset);
    output.set(item.z, item.offset);
  }
  return output;
}

/** Return the event ID embedded in an event-quest ARC, if any. */
export function eventIdOfArc(arc) {
  for (const record of arc.records) {
    const match = record.name.match(/(?:questData|questLink|supp)_(\d{7})(?:_[a-z]{3})?$/i);
    if (match && match[1] !== '0000000') return match[1];
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* GMD                                                                        */
/* -------------------------------------------------------------------------- */

export function parseGmd(source) {
  const bytes = bytesOf(source);
  if (!startsWith(bytes, 0, [0x47, 0x4D, 0x44, 0x00])) throw new Error('not a GMD file');
  if (bytes.length < 0x24) throw new Error('truncated GMD header');
  const count = u32(bytes, 0x18);
  const textSize = u32(bytes, 0x20);
  const start = bytes.length - textSize;
  if (start < 0x24 || start > bytes.length) throw new Error('bad GMD text-table size');
  const parts = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    let stop = cursor;
    while (stop < bytes.length && bytes[stop] !== 0) stop++;
    if (stop >= bytes.length) throw new Error('unterminated GMD string');
    parts.push(utf8Decoder.decode(bytes.subarray(cursor, stop)));
    cursor = stop + 1;
  }
  // Some files have trailing NUL bytes after the declared strings.
  while (cursor < bytes.length && bytes[cursor] === 0) cursor++;
  if (cursor !== bytes.length) throw new Error('unexpected trailing bytes after GMD strings');
  return { bytes, count, textSize, start, strings: parts };
}

export function buildGmd(original, strings) {
  const gmd = parseGmd(original);
  if (strings.length !== gmd.count) throw new Error(`GMD string count ${strings.length} != ${gmd.count}`);
  const outputStrings = [];
  for (const string of strings) {
    if (String(string).includes('\x00')) throw new Error('GMD string contains NUL');
    const encoded = utf8Encoder.encode(String(string));
    outputStrings.push(encoded, new Uint8Array([0]));
  }
  const textSize = outputStrings.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(gmd.start + textSize);
  output.set(gmd.bytes.subarray(0, gmd.start), 0);
  setU32(output, 0x20, textSize);
  let cursor = gmd.start;
  for (const part of outputStrings) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

const TAG_RE = /<[^>]*>/g;

export function tagSequence(text) {
  return [...String(text).matchAll(TAG_RE)].map((match) => match[0]);
}

function sameTags(a, b) {
  const ta = tagSequence(a);
  const tb = tagSequence(b);
  return ta.length === tb.length && ta.every((value, index) => value === tb[index]);
}

/* -------------------------------------------------------------------------- */
/* Palico                                                                     */
/* -------------------------------------------------------------------------- */

export function parseCat(source) {
  const bytes = bytesOf(source);
  if (bytes.length !== PALICO_SIZE) throw new Error(`Palico record must be ${PALICO_SIZE} bytes`);
  const name = cString(bytes, CAT_NAME_OFFSET, CAT_NAME_SIZE);
  return {
    bytes: new Uint8Array(bytes),
    name,
    owner: cString(bytes, CAT_OWNER_OFFSET, CAT_OWNER_SIZE),
    shoutout: cString(bytes, CAT_SHOUT_OFFSET, CAT_SHOUT_SIZE),
    valid: name.length > 0 && !/^\uFFFD+$/.test(name) && bytes[0] !== 0xFF,
  };
}

export function catSourceFromFile(fileName, source) {
  const bytes = bytesOf(source);
  if (bytes.length !== PALICO_SIZE) throw new Error(`${fileName}: expected ${PALICO_SIZE} bytes, got ${bytes.length}`);
  const cat = parseCat(bytes);
  if (!cat.valid) throw new Error(`${fileName}: invalid/empty Palico record`);
  const id = String(fileName).replace(/\.catzx$/i, '');
  return {
    id,
    fileName: String(fileName),
    originalName: cat.name,
    bytes: cat.bytes,
    matchNames: unique([id, cat.name]),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function findPalicoTranslation(translation, names, id) {
  const table = translation?.palico || translation?.cats || {};
  for (const key of unique([id, ...names])) {
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  }
  for (const [key, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== 'object') continue;
    const matches = [key, entry.id, entry.originalName, ...(entry.match || []), ...(entry.matchNames || [])];
    if (matches.some((value) => names.includes(value))) return entry;
  }
  return null;
}

function palicoSlots(save, selectedIndexes) {
  const active = save.characters.filter((character) => character.used);
  if (!selectedIndexes) return active;
  const selected = new Set(selectedIndexes);
  return active.filter((character) => selected.has(character.index));
}

function findHighestPalico(bytes, character) {
  let best = null;
  const base = character.offset + PALICO_BASE_OFFSET;
  if (base + PALICO_SLOTS * PALICO_SIZE > bytes.length) return null;
  for (let i = 0; i < PALICO_SLOTS; i++) {
    const cat = parseCat(bytes.subarray(base + i * PALICO_SIZE, base + (i + 1) * PALICO_SIZE));
    if (!cat.valid) continue;
    const level = cat.bytes[0x24] + 1;
    const exp = u32(cat.bytes, 0x20);
    if (!best || level > best.level || (level === best.level && exp > best.exp)) {
      best = { level, exp };
    }
  }
  return best;
}

function applyPalicoLevel(record, levelInfo) {
  const level = Math.max(1, Math.min(99, Math.trunc(levelInfo?.level || 1)));
  record[0x24] = level - 1;
  setU32(record, 0x20, Math.max(0, Math.trunc(levelInfo?.exp || 0)));
}

function sourceAliasNames(source, translation) {
  const entry = findPalicoTranslation(translation, source.matchNames || [], source.id) || {};
  return unique([
    source.id,
    source.originalName,
    ...(source.matchNames || []),
    entry.name,
  ]);
}

/** Match existing Palico records to selected special cats by name.
 * This is used only to avoid appending a duplicate; matched records are never
 * modified.  The 324-byte record has no verified stable cat ID, so the
 * user-visible name is the only practical append-time key. */
function matchExistingPalicos(existing, sources, translation) {
  const aliases = sources.map((source) => ({
    source,
    entry: findPalicoTranslation(translation, source.matchNames || [], source.id),
    names: sourceAliasNames(source, translation),
  }));
  const byName = new Map();
  aliases.forEach((item, index) => {
    for (const name of item.names) {
      if (!byName.has(name)) byName.set(name, []);
      const indexes = byName.get(name);
      if (!indexes.includes(index)) indexes.push(index);
    }
  });

  const matched = new Map();
  const matchedExisting = new Set();
  const ambiguous = new Set();
  for (const item of existing) {
    const indexes = byName.get(item.cat.name) || [];
    // Two source cats can share the same original name.  Pair occurrences
    // one-to-one instead of refusing to match both; translated names are
    // normally unique, so later runs naturally converge to the precise cat.
    const sourceIndex = indexes.find((index) => !matched.has(index));
    if (sourceIndex !== undefined) {
      matched.set(sourceIndex, item);
      matchedExisting.add(item.index);
    } else if (indexes.length > 1) {
      ambiguous.add(item.cat.name);
    }
  }
  return { matched, matchedExisting, ambiguous, aliases };
}

function planCharacterPalicos(character, sources, translation, bytes, keepCatLevel) {
  const base = character.offset + PALICO_BASE_OFFSET;
  const existing = [];
  if (bytes) {
    for (let i = 0; i < PALICO_SLOTS; i++) {
      const cat = parseCat(bytes.subarray(base + i * PALICO_SIZE, base + (i + 1) * PALICO_SIZE));
      if (cat.valid) existing.push({ index: i, cat });
    }
  }
  const matchedInfo = matchExistingPalicos(existing, sources, translation);
  const free = PALICO_SLOTS - existing.length;
  const required = sources.length - matchedInfo.matched.size;
  const level = keepCatLevel ? (findHighestPalico(bytes, character) || { level: 1, exp: 0 }) : { level: 1, exp: 0 };
  return {
    slot: character.index + 1,
    name: character.name,
    existing: existing.length,
    level,
    free,
    selected: sources.length,
    required,
    needed: required,
    alreadyPresent: matchedInfo.matched.size,
    matchedExisting: matchedInfo.matched.size,
    ambiguous: [...matchedInfo.ambiguous],
    overflow: required > free,
  };
}

/** Preflight Palico import/update. Does not modify any bytes. */
export function planPalicoMerge(save, sourceCats, options = {}) {
  const sources = (sourceCats || []).filter((cat) => cat && cat.bytes && cat.bytes.length === PALICO_SIZE);
  const translation = options.translation || {};
  const keepCatLevel = Boolean(options.keepCatLevel);
  const slots = palicoSlots(save, options.catSlots);
  const characters = slots.map((character) =>
    planCharacterPalicos(character, sources, translation, options.bytes || save.bytes, keepCatLevel));
  const overflow = characters.some((row) => row.overflow > 0);
  const ambiguous = [...new Set(characters.flatMap((row) => row.ambiguous))];
  return {
    sources: sources.length,
    characters,
    overflow,
    ambiguous,
    keepCatLevel,
    message: overflow
      ? characters
        .filter((row) => row.overflow > 0)
        .map((row) => `角色 ${row.slot}：需要 ${row.required} 个空槽，但只剩 ${row.free} 个（已有 ${row.existing} 只）`)
        .join('；')
      : '',
  };
}

function applyCatTranslation(record, entry) {
  const warnings = [];
  if (!entry) return { warnings, changed: false };
  let changed = false;
  for (const [field, offset, size] of [
    ['name', CAT_NAME_OFFSET, CAT_NAME_SIZE],
    ['owner', CAT_OWNER_OFFSET, CAT_OWNER_SIZE],
    ['shoutout', CAT_SHOUT_OFFSET, CAT_SHOUT_SIZE],
  ]) {
    if (entry[field] === undefined || entry[field] === null) continue;
    try {
      writeCString(record, offset, size, entry[field]);
      changed = true;
    } catch (error) {
      warnings.push(`${field}: ${error.message}`);
    }
  }
  return { warnings, changed };
}

/** Always create a fresh default weapon record for an appended cat.
 * Never reuse the player's existing gear: a normally obtained or rare weapon
 * must not become a free weapon for imported cats. */
function allocateDefaultPalicoWeapon(saveBytes, characterOffset) {
  const base = characterOffset + PALICO_EQUIPMENT_OFFSET;
  if (base < 0 || base + PALICO_EQUIPMENT_SLOTS * PALICO_EQUIPMENT_SIZE > saveBytes.length) {
    return 0xFFFF;
  }
  for (let i = 0; i < PALICO_EQUIPMENT_SLOTS; i++) {
    if (saveBytes[base + i * PALICO_EQUIPMENT_SIZE] === 0) {
      saveBytes.set(DEFAULT_PALICO_WEAPON, base + i * PALICO_EQUIPMENT_SIZE);
      return i;
    }
  }
  return 0xFFFF;
}

/** Give a newly appended cat the freshly created default weapon slot.
 * Head and armor are left empty. */
function setSafePalicoEquipment(record, weaponSlot) {
  setU16(record, CAT_EQUIP_OFFSET, weaponSlot);
  setU16(record, CAT_EQUIP_OFFSET + 2, 0xFFFF);
  setU16(record, CAT_EQUIP_OFFSET + 4, 0xFFFF);
}

export function mergePalicos(save, sourceCats, options = {}) {
  const out = new Uint8Array(save.bytes);
  const translation = options.translation || {};
  const sources = (sourceCats || []).filter((cat) => cat && cat.bytes && cat.bytes.length === PALICO_SIZE);
  const mergeCats = Boolean(options.mergeCats);
  const report = {
    enabled: mergeCats,
    sourceCount: sources.length,
    characters: [],
    added: 0,
    skippedExisting: 0,
    skippedFull: 0,
    warnings: [],
  };
  report.keepCatLevel = Boolean(mergeCats && options.keepCatLevel);

  const slots = palicoSlots(save, options.catSlots);
  if (mergeCats) {
    const plan = planPalicoMerge(save, sources, { ...options, bytes: out });
    report.capacity = plan;
    if (plan.overflow) {
      throw new Error(`随从猫槽位不足：${plan.message}。已停止，未生成新存档。`);
    }
  }

  for (const character of slots) {
    const base = character.offset + PALICO_BASE_OFFSET;
    if (base + PALICO_SLOTS * PALICO_SIZE > out.length) {
      report.warnings.push(`角色 ${character.index + 1}: Palico 区域越界，已跳过`);
      continue;
    }
    const existing = [];
    for (let i = 0; i < PALICO_SLOTS; i++) {
      const cat = parseCat(out.subarray(base + i * PALICO_SIZE, base + (i + 1) * PALICO_SIZE));
      if (cat.valid) existing.push({ index: i, cat });
    }
    const matchInfo = matchExistingPalicos(existing, sources, translation);
    const levelInfo = mergeCats && options.keepCatLevel
      ? (findHighestPalico(out, character) || { level: 1, exp: 0 })
      : { level: 1, exp: 0 };
    const characterReport = {
      slot: character.index + 1,
      name: character.name,
      before: existing.length,
      level: levelInfo,
      added: 0,
      skippedExisting: 0,
      skippedFull: 0,
      after: existing.length,
    };

    if (mergeCats) {
      // Append-only: matched cats are skipped and never modified.  This is
      // intentional; translation updates are not part of this tool.
      for (let i = 0; i < matchInfo.matched.size; i++) {
        characterReport.skippedExisting++;
        report.skippedExisting++;
      }

      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        if (matchInfo.matched.has(sourceIndex)) continue;
        const source = sources[sourceIndex];
        let targetIndex = -1;
        for (let i = 0; i < PALICO_SLOTS; i++) {
          const cat = parseCat(out.subarray(base + i * PALICO_SIZE, base + (i + 1) * PALICO_SIZE));
          if (!cat.valid) {
            targetIndex = i;
            break;
          }
        }
        if (targetIndex < 0) {
          characterReport.skippedFull++;
          report.skippedFull++;
          report.warnings.push(`角色 ${character.index + 1}: 随从猫槽已满，${source.id} 未加入`);
          continue;
        }
        const record = new Uint8Array(source.bytes);
        applyPalicoLevel(record, levelInfo);
        // Never copy donor equipment references into the target save.
        setSafePalicoEquipment(record, allocateDefaultPalicoWeapon(out, character.offset));
        const entry = matchInfo.aliases[sourceIndex].entry;
        const result = applyCatTranslation(record, entry);
        for (const warning of result.warnings) {
          report.warnings.push(`角色 ${character.index + 1} / ${source.id}: ${warning}`);
        }
        out.set(record, base + targetIndex * PALICO_SIZE);
        characterReport.added++;
        report.added++;
      }
    }
    characterReport.after = characterReport.before + characterReport.added;
    report.characters.push(characterReport);
  }
  return { bytes: out, report };
}

/* -------------------------------------------------------------------------- */
/* DLC / event quests                                                         */
/* -------------------------------------------------------------------------- */

function eventTranslation(translation, eventId) {
  const table = translation?.events || translation?.dlc || {};
  return table[eventId] || table[String(Number(eventId))] || null;
}

function recordOverrides(entry, recordName) {
  if (!entry || typeof entry !== 'object') return null;
  const table = entry.records && typeof entry.records === 'object' ? entry.records : entry;
  const shortName = recordName.split(/[\\/]/).pop();
  return table[recordName] ?? table[shortName] ?? null;
}

function applyEventTranslation(sourceBytes, arc, eventId, translation, warnings) {
  const entry = eventTranslation(translation, eventId);
  if (!entry) return null;
  const replacements = new Map();
  for (const record of arc.records) {
    if (!startsWith(record.data, 0, [0x47, 0x4D, 0x44, 0x00])) continue;
    const overrides = recordOverrides(entry, record.name);
    if (!overrides) continue;
    const gmd = parseGmd(record.data);
    const strings = gmd.strings.slice();
    let changed = false;
    for (const [rawIndex, value] of Object.entries(overrides)) {
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= strings.length) {
        throw new Error(`${eventId}/${record.name}: GMD index ${rawIndex} out of range`);
      }
      if (value === null || value === undefined) continue;
      const original = strings[index];
      const translated = String(value);
      if (!sameTags(original, translated)) {
        warnings.push(`${eventId}/${record.name}[${index}]: tag sequence changed`);
      }
      strings[index] = translated;
      changed = true;
    }
    if (changed) replacements.set(record.name, buildGmd(record.data, strings));
  }
  if (replacements.size === 0) return null;
  return buildArc(sourceBytes, arc, replacements);
}

function eventSlotBytes(sourceBytes, arc, translation, warnings) {
  const eventId = eventIdOfArc(arc);
  const start = arc.offset - EVENT_SLOT_HEADER;
  const translated = applyEventTranslation(sourceBytes, arc, eventId, translation, warnings);
  if (!translated) {
    const block = new Uint8Array(EVENT_SLOT_SIZE);
    block.set(sourceBytes.subarray(start, Math.min(sourceBytes.length, start + EVENT_SLOT_SIZE)), 0);
    return block;
  }
  const sourceArcSize = u32(sourceBytes, start + 4);
  const tailStart = start + EVENT_SLOT_HEADER + sourceArcSize;
  const tail = sourceBytes.subarray(tailStart, Math.min(sourceBytes.length, start + EVENT_SLOT_SIZE));
  if (EVENT_SLOT_HEADER + translated.length + tail.length > EVENT_SLOT_SIZE) {
    throw new Error(`event ${eventId} translated ARC is ${translated.length} bytes, exceeds slot ${EVENT_SLOT_SIZE - EVENT_SLOT_HEADER}`);
  }
  const block = new Uint8Array(EVENT_SLOT_SIZE);
  setU32(block, 0, Number(eventId));
  setU32(block, 4, translated.length);
  block.set(translated, EVENT_SLOT_HEADER);
  block.set(tail, EVENT_SLOT_HEADER + translated.length);
  return block;
}

function findFreeEventSlot(target, occupiedOffsets, preferredOffset) {
  const first = Math.min(...target.characters.filter((character) => character.used).map((character) => character.offset));
  if (preferredOffset >= GLOBAL_EVENT_BASE && preferredOffset + EVENT_SLOT_SIZE <= first &&
      allZero(target.bytes, preferredOffset, preferredOffset + EVENT_SLOT_SIZE)) return preferredOffset;
  for (let offset = GLOBAL_EVENT_BASE; offset + EVENT_SLOT_SIZE <= first; offset += EVENT_SLOT_SIZE) {
    if (occupiedOffsets.some((used) => rangesOverlap(offset, offset + EVENT_SLOT_SIZE, used, used + EVENT_SLOT_SIZE))) continue;
    if (allZero(target.bytes, offset, offset + EVENT_SLOT_SIZE)) return offset;
  }
  return -1;
}

export function mergeDlc(target, donor, options = {}) {
  const out = new Uint8Array(target.bytes);
  const translation = options.translation || {};
  const warnings = [];
  const sourceEvents = donor
    ? donor.globalArcs.map((arc) => ({ arc, eventId: eventIdOfArc(arc) })).filter((item) => item.eventId)
    : [];
  // Copy the small DLC descriptor fields and the global event-quest metadata
  // table from the donor.  Event slots alone are not enough for the Hub list.
  const targetGlobalSettings = out.slice(
    DLC_GLOBAL_SETTINGS_OFFSET,
    DLC_GLOBAL_SETTINGS_OFFSET + DLC_GLOBAL_SETTINGS_SIZE,
  );
  if (donor) {
    for (const offset of DLC_HEADER_FIELDS) {
      if (offset + DLC_HEADER_BYTES <= out.length && offset + DLC_HEADER_BYTES <= donor.bytes.length) {
        out.set(donor.bytes.subarray(offset, offset + DLC_HEADER_BYTES), offset);
      }
    }
    const tableEnd = DLC_EVENT_TABLE_OFFSET + DLC_EVENT_TABLE_SIZE;
    if (tableEnd <= out.length && tableEnd <= donor.bytes.length) {
      out.set(donor.bytes.subarray(DLC_EVENT_TABLE_OFFSET, tableEnd), DLC_EVENT_TABLE_OFFSET);
    }
    const flagsEnd = DLC_EVENT_FLAGS_OFFSET + DLC_EVENT_FLAGS_SIZE;
    if (flagsEnd <= out.length && flagsEnd <= donor.bytes.length) {
      out.set(donor.bytes.subarray(DLC_EVENT_FLAGS_OFFSET, flagsEnd), DLC_EVENT_FLAGS_OFFSET);
    }
    out.set(targetGlobalSettings, DLC_GLOBAL_SETTINGS_OFFSET);
  }
  const targetEvents = new Map();
  for (const arc of target.globalArcs) {
    const eventId = eventIdOfArc(arc);
    if (eventId) targetEvents.set(eventId, arc);
  }
  const occupiedOffsets = target.globalArcs.map((arc) => arc.offset - EVENT_SLOT_HEADER);
  const handled = new Set();
  const report = {
    enabled: Boolean(options.mergeDlc || options.translateDlc),
    sourceCount: sourceEvents.length,
    targetBefore: targetEvents.size,
    added: 0,
    replaced: 0,
    translatedExisting: 0,
    skipped: 0,
    targetAfter: targetEvents.size,
    tableCopied: Boolean(donor),
    flagsCopied: Boolean(donor),
    settingsPreserved: true,
    warnings,
  };

  for (const { arc: sourceArc, eventId } of sourceEvents) {
    const existing = targetEvents.get(eventId);
    let destination = existing
      ? existing.offset - EVENT_SLOT_HEADER
      : findFreeEventSlot(target, occupiedOffsets, sourceArc.offset - EVENT_SLOT_HEADER);
    if (destination < 0 || destination + EVENT_SLOT_SIZE > target.firstCharacterOffset) {
      report.skipped++;
      warnings.push(`事件任务 ${eventId}: 目标存档没有空闲事件槽`);
      continue;
    }
    let block;
    try {
      block = eventSlotBytes(donor.bytes, sourceArc, translation, warnings);
    } catch (error) {
      report.skipped++;
      warnings.push(`事件任务 ${eventId}: ${error.message}`);
      continue;
    }
    out.fill(0, destination, destination + EVENT_SLOT_SIZE);
    out.set(block, destination);
    if (!existing) {
      targetEvents.set(eventId, { offset: destination + EVENT_SLOT_HEADER });
      occupiedOffsets.push(destination);
      report.added++;
    } else {
      report.replaced++;
    }
    handled.add(eventId);
  }

  // Target-only DLC: apply translation overrides in place without touching the
  // donor data or any character block.
  if (options.translateDlc !== false) {
    for (const [eventId, targetArc] of targetEvents) {
      if (handled.has(eventId) || !targetArc.records) continue;
      const entry = eventTranslation(translation, eventId);
      if (!entry) continue;
      try {
        const translated = applyEventTranslation(out, targetArc, eventId, translation, warnings);
        if (!translated) continue;
        if (EVENT_SLOT_HEADER + translated.length > EVENT_SLOT_SIZE) {
          throw new Error('translated ARC exceeds slot size');
        }
        const start = targetArc.offset - EVENT_SLOT_HEADER;
        const oldSize = u32(out, start + 4);
        const oldTail = out.subarray(start + EVENT_SLOT_HEADER + oldSize,
          Math.min(out.length, start + EVENT_SLOT_SIZE));
        if (EVENT_SLOT_HEADER + translated.length + oldTail.length > EVENT_SLOT_SIZE) {
          throw new Error('translated ARC + tail exceeds slot size');
        }
        const block = new Uint8Array(EVENT_SLOT_SIZE);
        setU32(block, 0, Number(eventId));
        setU32(block, 4, translated.length);
        block.set(translated, EVENT_SLOT_HEADER);
        block.set(oldTail, EVENT_SLOT_HEADER + translated.length);
        out.fill(0, start, start + EVENT_SLOT_SIZE);
        out.set(block, start);
        report.translatedExisting++;
      } catch (error) {
        warnings.push(`事件任务 ${eventId}: ${error.message}`);
      }
    }
  }
  report.targetAfter = targetEvents.size;
  return { bytes: out, report };
}

/* -------------------------------------------------------------------------- */
/* Save parsing                                                               */
/* -------------------------------------------------------------------------- */

function indexOfBytes(bytes, needle, start, limit) {
  for (let i = start; i + needle.length <= limit; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function scanArcs(source, start = 0, limit = source.length) {
  const bytes = bytesOf(source);
  const arcs = [];
  let cursor = start;
  while (cursor + 4 <= limit) {
    const found = indexOfBytes(bytes, [0x41, 0x52, 0x43, 0x00], cursor, limit);
    if (found < 0) break;
    try {
      const arc = parseArcAt(bytes, found, limit);
      const sane = arc.records.every((record) => record.name.includes('\\') || record.name.includes('/'));
      if (sane) arcs.push(arc);
      cursor = found + Math.max(4, arc.rawSize);
    } catch {
      cursor = found + 4;
    }
  }
  return arcs;
}

export function parseSave(source) {
  const bytes = new Uint8Array(bytesOf(source));
  if (bytes.length < 0x100) throw new Error('存档文件太小');
  const flags = [bytes[4], bytes[5], bytes[6]];
  const offsets = [u32(bytes, 0x10), u32(bytes, 0x14), u32(bytes, 0x18)];
  if (offsets.some((offset) => offset < 0x40 || offset >= bytes.length)) {
    throw new Error('无法识别存档：角色偏移无效');
  }
  const characters = offsets.map((offset, index) => {
    const name = cString(bytes, offset, 0x20);
    const used = flags[index] !== 0;
    return {
      index,
      used,
      flag: flags[index],
      offset,
      name,
      palicoOffset: offset + PALICO_BASE_OFFSET,
      palicoEnd: offset + PALICO_BASE_OFFSET + PALICO_SLOTS * PALICO_SIZE,
    };
  });
  const active = characters.filter((character) => character.used);
  if (active.length === 0) throw new Error('存档中没有已启用的角色槽');
  const firstCharacterOffset = Math.min(...active.map((character) => character.offset));
  const globalArcs = scanArcs(bytes, 0, firstCharacterOffset);
  for (const character of characters) {
    const next = characters
      .filter((candidate) => candidate.offset > character.offset)
      .map((candidate) => candidate.offset)
      .sort((a, b) => a - b)[0] || bytes.length;
    character.end = next;
    character.arcs = scanArcs(bytes, character.offset, Math.min(next, bytes.length));
    character.cats = [];
    if (character.palicoEnd <= bytes.length) {
      for (let i = 0; i < PALICO_SLOTS; i++) {
        const cat = parseCat(bytes.subarray(character.palicoOffset + i * PALICO_SIZE,
          character.palicoOffset + (i + 1) * PALICO_SIZE));
        if (cat.valid) character.cats.push({ index: i, cat });
      }
    }
  }
  const globalEvents = globalArcs.map((arc) => eventIdOfArc(arc)).filter(Boolean);
  return {
    bytes,
    size: bytes.length,
    flags,
    offsets,
    characters,
    active,
    firstCharacterOffset,
    globalArcs,
    globalEvents,
    eventCount: new Set(globalEvents).size,
  };
}

export function inspectSave(save) {
  return {
    size: save.size,
    flags: save.flags,
    offsets: save.offsets,
    activeCharacters: save.active.map((character) => ({
      slot: character.index + 1,
      name: character.name,
      offset: character.offset,
      cats: character.cats.length,
    })),
    globalArcCount: save.globalArcs.length,
    eventCount: save.eventCount,
    eventIds: [...new Set(save.globalEvents)].sort(),
  };
}

/* -------------------------------------------------------------------------- */
/* Combined operation                                                         */
/* -------------------------------------------------------------------------- */

export function mergeSave(target, donor, options = {}) {
  let result = new Uint8Array(target.bytes);
  const reports = {};
  if (options.mergeDlc || options.translateDlc) {
    const dlc = mergeDlc(target, donor, options);
    result = dlc.bytes;
    reports.dlc = dlc.report;
  }
  if (options.mergeCats) {
    const after = parseSave(result);
    const palico = mergePalicos(after, options.cats || [], options);
    result = palico.bytes;
    reports.palico = palico.report;
  }
  return { bytes: result, reports };
}

export function sha256Hex(source) {
  const bytes = bytesOf(source);
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle.digest('SHA-256', bytes).then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    );
  }
  throw new Error('SHA-256 unavailable');
}

