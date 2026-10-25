import {
  PALICO_SLOTS,
  PALICO_SIZE,
  SAVE_SIZE,
  catSourceFromFile,
  findPalicoTranslation,
  inspectSave,
  mergeSave,
  parseCat,
  parseSave,
  planPalicoMerge,
  sha256Hex,
} from './core.js';
import { zipSync } from '../vendor/fflate.mjs';

const $ = (selector) => document.querySelector(selector);
const enc = new TextEncoder();
const contentOffsets = [0x126474, 0x244c34, 0x3633f4];

const elements = {
  targetFile: $('#targetFile'),
  targetDrop: $('#targetDrop'),
  targetSummary: $('#targetSummary'),
  catSlotPanel: $('#catSlotPanel'),
  catSlotList: $('#catSlotList'),
  selectAllCatSlots: $('#selectAllCatSlots'),
  selectNoCatSlots: $('#selectNoCatSlots'),
  catPickerPanel: $('#catPickerPanel'),
  catPicker: $('#catPicker'),
  catSelectionSummary: $('#catSelectionSummary'),
  capacitySummary: $('#capacitySummary'),
  selectAllCats: $('#selectAllCats'),
  selectNoCats: $('#selectNoCats'),
  mergeDlc: $('#mergeDlc'),
  mergeCats: $('#mergeCats'),
  keepCatLevel: $('#keepCatLevel'),
  writeBackup: $('#writeBackup'),
  run: $('#run'),
  status: $('#status'),
  resultPanel: $('#resultPanel'),
  resultHint: $('#resultHint'),
  resultStats: $('#resultStats'),
  downloads: $('#downloads'),
  reportText: $('#reportText'),
};

const state = {
  targetBytes: null,
  target: null,
  content: null,
  donor: null,
  catSources: [],
  selectedCats: new Set(),
  selectedCatSlots: new Set(),
  translation: {},
  processing: false,
};

function setStatus(text, kind = '') {
  elements.status.textContent = text;
  elements.status.className = `status ${kind}`.trim();
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function summarize(save) {
  const info = inspectSave(save);
  const chars = info.activeCharacters
    .map((character) => `槽 ${character.slot}「${character.name || '未命名'}」× ${character.cats} 猫`)
    .join('；');
  return [
    `大小 ${formatBytes(info.size)}`,
    `启用角色 ${info.activeCharacters.length} 个`,
    `全局事件 ${info.eventCount} 个`,
    chars ? `角色：${chars}` : '无已启用角色',
  ].join('\n');
}

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Recreate a donor-like save from the bundled event slots, so the merge
 * engine can use exactly the same event-slot path as the old donor mode. */
function contentDonor(content) {
  const bytes = new Uint8Array(SAVE_SIZE);
  bytes[4] = 1;
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 3; i++) view.setUint32(0x10 + i * 4, contentOffsets[i], true);
  for (const event of content.events) {
    if (event.offset < 0 || event.offset + 0x1400 > SAVE_SIZE) {
      throw new Error(`内容事件 ${event.id} 的槽位越界`);
    }
    const block = decodeBase64(event.slot_b64);
    if (block.length !== 0x1400) throw new Error(`内容事件 ${event.id} 槽位大小错误`);
    bytes.set(block, event.offset - 8);
  }
  if (content.dlcHeader) {
    if (content.dlcHeader['0x154']) bytes.set(decodeBase64(content.dlcHeader['0x154']), 0x154);
    if (content.dlcHeader['0x298']) bytes.set(decodeBase64(content.dlcHeader['0x298']), 0x298);
  }
  if (content.dlcTable?.bytes_b64) {
    bytes.set(decodeBase64(content.dlcTable.bytes_b64), content.dlcTable.offset);
  }
  if (content.dlcFlags?.bytes_b64) {
    bytes.set(decodeBase64(content.dlcFlags.bytes_b64), content.dlcFlags.offset);
  }
  return parseSave(bytes);
}

async function loadContent() {
  try {
    const response = await fetch('./data/content.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = await response.json();
    if (!Array.isArray(content.events) || !Array.isArray(content.palicoes)) {
      throw new Error('内容包格式不正确');
    }
    state.content = content;
    state.translation = content.translation || { palico: {} };
    state.catSources = content.palicoes.map((cat) =>
      catSourceFromFile(`${cat.id}.catzx`, decodeBase64(cat.bytes_b64))
    );
    state.donor = contentDonor(content);
    resetCatSelection(state.catSources);
    elements.mergeDlc.checked = true;
    elements.mergeCats.checked = true;
    elements.mergeDlc.disabled = false;
    elements.mergeCats.disabled = false;
    renderCatPicker();
    updateCapacity();
  } catch (error) {
    state.content = null;
    state.donor = null;
    state.catSources = [];
    state.translation = {};
    elements.mergeDlc.disabled = true;
    elements.mergeCats.disabled = true;
    renderCatPicker();
    updateCapacity();
    setStatus(`内置内容加载失败：${error.message}`, 'bad');
  }
}

async function loadTarget(file) {
  if (!file) {
    state.targetBytes = null;
    state.target = null;
    state.selectedCatSlots.clear();
    elements.targetSummary.textContent = '尚未选择目标存档。';
    elements.targetSummary.className = 'summary muted';
    renderCatSlotPicker();
    renderCatPicker();
    updateCapacity();
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const save = parseSave(bytes);
    state.targetBytes = bytes;
    state.target = save;
    state.selectedCatSlots = new Set(save.active.map((character) => character.index));
    elements.targetSummary.textContent = `${file.name}\n${summarize(save)}`;
    elements.targetSummary.className = 'summary good';
    renderCatSlotPicker();
    renderCatPicker();
    updateCapacity();
    setStatus('目标存档解析成功。', 'good');
  } catch (error) {
    state.targetBytes = null;
    state.target = null;
    state.selectedCatSlots.clear();
    elements.targetSummary.textContent = `无法解析：${error.message}`;
    elements.targetSummary.className = 'summary bad';
    renderCatSlotPicker();
    renderCatPicker();
    updateCapacity();
    setStatus(`目标存档解析失败：${error.message}`, 'bad');
  }
}

function renderCatSlotPicker() {
  const slots = state.target?.active || [];
  elements.catSlotPanel.hidden = slots.length === 0;
  elements.catSlotList.replaceChildren();
  for (const character of slots) {
    const label = document.createElement('label');
    label.className = 'check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedCatSlots.has(character.index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedCatSlots.add(character.index);
      else state.selectedCatSlots.delete(character.index);
      updateCapacity();
    });
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = `槽 ${character.index + 1}「${character.name || '未命名'}」`;
    const small = document.createElement('small');
    small.textContent = `已有 ${character.cats.length} 只猫`;
    text.append(strong, small);
    label.append(checkbox, text);
    elements.catSlotList.append(label);
  }
}

function selectedCatSlotIndexes() {
  const active = new Set((state.target?.active || []).map((character) => character.index));
  return [...state.selectedCatSlots]
    .filter((index) => active.has(index))
    .sort((a, b) => a - b);
}

function resetCatSelection(sources) {
  state.selectedCats = new Set(sources.map((_, index) => index));
}

function selectedCatSources() {
  return state.catSources.filter((_, index) => state.selectedCats.has(index));
}

function catInfo(source) {
  const cat = parseCat(source.bytes);
  const entry = findPalicoTranslation(state.translation, source.matchNames || [], source.id) || {};
  return {
    name: entry.name || source.originalName || cat.name,
    originalName: source.originalName || cat.name,
    owner: entry.owner || cat.owner,
    shoutout: entry.shoutout || cat.shoutout,
    description: entry.description || entry.desc || '',
    image: entry.image || entry.preview || '',
  };
}

function renderCatPicker() {
  const sources = state.catSources;
  state.selectedCats = new Set([...state.selectedCats].filter((index) => index < sources.length));
  if (sources.length === 0) {
    elements.catPickerPanel.hidden = true;
    elements.catPicker.replaceChildren();
    updateCatSelectionSummary();
    return;
  }
  elements.catPickerPanel.hidden = false;
  elements.catPicker.replaceChildren();
  sources.forEach((source, index) => {
    const info = catInfo(source);
    const label = document.createElement('label');
    label.className = 'cat-choice';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedCats.has(index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedCats.add(index);
      else state.selectedCats.delete(index);
      updateCatSelectionSummary();
      updateCapacity();
    });

    const avatar = document.createElement('span');
    avatar.className = 'cat-avatar';
    if (info.image) {
      const image = document.createElement('img');
      image.src = info.image;
      image.alt = '';
      image.loading = 'lazy';
      avatar.append(image);
    } else {
      avatar.textContent = info.name.slice(0, 1) || '猫';
    }

    const text = document.createElement('span');
    text.className = 'cat-info';
    const strong = document.createElement('strong');
    strong.textContent = info.name;
    const sub = document.createElement('small');
    const original = info.originalName && info.originalName !== info.name
      ? `${info.originalName} · `
      : '';
    sub.textContent = `${original}${info.owner || '未知主人'}`;
    const desc = document.createElement('span');
    desc.className = 'cat-desc';
    desc.textContent = info.description || (info.shoutout ? `口头禅：${info.shoutout}` : '暂无中文简介');
    text.append(strong, sub, desc);

    label.append(checkbox, avatar, text);
    elements.catPicker.append(label);
  });
  updateCatSelectionSummary();
  updateCapacity();
}

function updateCatSelectionSummary() {
  const total = state.catSources.length;
  const selected = selectedCatSources().length;
  elements.catSelectionSummary.textContent = total
    ? `已选择 ${selected} / ${total} 只特殊随从猫`
    : '没有可导入的特殊随从猫';
  elements.catSelectionSummary.className = `cat-selection-summary${selected === 0 ? ' bad' : ''}`;
}

function updateCapacity() {
  if (!elements.capacitySummary) return;
  if (!state.target) {
    elements.capacitySummary.textContent = '';
    elements.capacitySummary.className = 'capacity-summary muted';
    updateRunState();
    return;
  }
  const sources = selectedCatSources();
  if (!elements.mergeCats.checked) {
    elements.capacitySummary.textContent = '未勾选追加特殊随从猫。';
    elements.capacitySummary.className = 'capacity-summary muted';
    updateRunState();
    return;
  }
  const catSlots = selectedCatSlotIndexes();
  if (catSlots.length === 0) {
    elements.capacitySummary.textContent = '未选择要写入的角色槽。';
    elements.capacitySummary.className = 'capacity-summary bad';
    updateRunState();
    return;
  }
  if (sources.length === 0) {
    elements.capacitySummary.textContent = '尚未选择要导入的特殊随从猫。';
    elements.capacitySummary.className = 'capacity-summary bad';
    updateRunState();
    return;
  }
  const plan = planPalicoMerge(state.target, sources, {
    translation: state.translation,
    keepCatLevel: elements.keepCatLevel.checked,
    catSlots,
  });
  const rows = plan.characters.map((row) => {
    const levelText = plan.keepCatLevel
      ? `导入 Lv${row.level.level} / exp ${row.level.exp}`
      : '导入 Lv1 / exp 0';
    return `角色 ${row.slot}：已有 ${row.existing}，空余 ${row.free}，需要 ${row.required}；${levelText}`;
  });
  elements.capacitySummary.textContent = plan.overflow
    ? `槽位不足，已停止处理。${plan.message}`
    : `槽位检查通过。${rows.join('；')}`;
  elements.capacitySummary.className = `capacity-summary ${plan.overflow ? 'bad' : 'good'}`;
  updateRunState(plan);
}

function updateRunState(plan = null) {
  if (!state.target || !state.content || state.processing) {
    elements.run.disabled = true;
    return;
  }
  if (elements.mergeCats.checked && selectedCatSources().length === 0) {
    elements.run.disabled = true;
    return;
  }
  if (elements.mergeCats.checked && selectedCatSlotIndexes().length === 0) {
    elements.run.disabled = true;
    return;
  }
  if (elements.mergeCats.checked && plan?.overflow) {
    elements.run.disabled = true;
    return;
  }
  elements.run.disabled = false;
}

function characterPreservation(before, after) {
  const rows = [];
  const length = Math.min(before.bytes.length, after.bytes.length);
  for (const character of before.characters) {
    const start = character.offset;
    const end = Math.min(character.end || length, length);
    if (start >= length) continue;
    const palicoStart = character.palicoOffset;
    const palicoEnd = character.palicoOffset + PALICO_SLOTS * PALICO_SIZE;
    let changedOutsidePalico = 0;
    let changedPalico = 0;
    for (let i = start; i < end; i++) {
      if (before.bytes[i] === after.bytes[i]) continue;
      if (i >= palicoStart && i < palicoEnd) changedPalico++;
      else changedOutsidePalico++;
    }
    rows.push({
      slot: character.index + 1,
      name: character.name,
      used: character.used,
      changedOutsidePalico,
      changedPalico,
    });
  }
  return rows;
}

function makeStat(label, value, detail = '') {
  const div = document.createElement('div');
  div.className = 'stat';
  const strong = document.createElement('b');
  strong.textContent = String(value);
  const small = document.createElement('small');
  small.textContent = detail ? `${label} · ${detail}` : label;
  div.append(strong, small);
  return div;
}

function addDownload(label, fileName, bytes, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.textContent = label;
  elements.downloads.append(link);
}

function clearDownloads() {
  for (const link of elements.downloads.querySelectorAll('a')) {
    URL.revokeObjectURL(link.href);
  }
  elements.downloads.replaceChildren();
}

function checkpointStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

async function safeSha256(bytes) {
  try {
    return await sha256Hex(bytes);
  } catch {
    return 'unavailable (需要 HTTPS/localhost 才能使用 Web Crypto)';
  }
}

async function run() {
  if (state.processing) return;
  if (!state.target) {
    setStatus('请先选择有效的目标存档。', 'bad');
    return;
  }
  if (!state.content) {
    setStatus('内置内容尚未加载完成。', 'bad');
    return;
  }
  state.processing = true;
  elements.run.disabled = true;
  clearDownloads();
  elements.resultPanel.hidden = true;
  setStatus('正在处理…');

  try {
    const catSources = selectedCatSources();
    const options = {
      mergeDlc: elements.mergeDlc.checked,
      translateDlc: false,
      mergeCats: elements.mergeCats.checked,
      keepCatLevel: elements.keepCatLevel.checked,
      catSlots: selectedCatSlotIndexes(),
      translation: state.translation,
      cats: catSources,
    };

    if (options.mergeCats && catSources.length === 0) {
      throw new Error('勾选了追加随从猫，但没有选中任何特殊随从猫');
    }
    if (options.mergeCats) {
      const plan = planPalicoMerge(state.target, catSources, {
        translation: state.translation,
        keepCatLevel: options.keepCatLevel,
        catSlots: options.catSlots,
      });
      if (plan.overflow) {
        throw new Error(`随从猫槽位不足：${plan.message}。已停止，未生成新存档。`);
      }
    }

    const result = mergeSave(state.target, state.donor, options);
    const outputSave = parseSave(result.bytes);
    const inputHash = await safeSha256(state.target.bytes);
    const outputHash = await safeSha256(result.bytes);
    const preservation = characterPreservation(state.target, outputSave);
    const report = {
      tool: 'mhxx-dlc-adder',
      generatedAt: new Date().toISOString(),
      content: {
        version: state.content.version || null,
        events: state.content.eventCount || state.content.events.length,
        cats: state.content.catCount || state.content.palicoes.length,
      },
      input: {
        name: elements.targetFile.files?.[0]?.name || 'system',
        size: state.target.bytes.length,
        sha256: inputHash,
        inspect: inspectSave(state.target),
      },
      options: {
        mergeDlc: options.mergeDlc,
        mergeCats: options.mergeCats,
        keepCatLevel: options.keepCatLevel,
        catSlots: options.catSlots,
        catSourceCount: catSources.length,
      },
      reports: result.reports,
      preservation,
      output: {
        size: result.bytes.length,
        sha256: outputHash,
        inspect: inspectSave(outputSave),
      },
    };

    const reportJson = JSON.stringify(report, null, 2);
    elements.reportText.textContent = reportJson;
    elements.resultHint.textContent = elements.writeBackup.checked
      ? '已生成 Checkpoint 存档包；请先阅读报告'
      : '已生成新的 system；请先阅读报告';
    elements.resultStats.replaceChildren(
      makeStat('事件任务', report.output.inspect.eventCount, `输入 ${report.input.inspect.eventCount}`),
      makeStat('全局 ARC', report.output.inspect.globalArcCount, `输入 ${report.input.inspect.globalArcCount}`),
      makeStat('随从猫', result.reports.palico?.added ?? 0, '仅追加到空槽'),
      makeStat('槽位检查', result.reports.palico?.capacity?.overflow ? '不足' : '通过', '所有启用角色'),
      makeStat('输出大小', formatBytes(result.bytes.length), '应与原存档相同'),
      makeStat('角色块', preservation.filter((row) => row.changedOutsidePalico === 0).length, '非 Palico 区域保持不变'),
    );

    if (elements.writeBackup.checked) {
      const folder = checkpointStamp();
      const zipEntries = {
        [`${folder}/system`]: result.bytes,
        [`${folder}/system_backup`]: result.bytes,
      };
      addDownload('下载新存档', `${folder}.zip`,
        zipSync(zipEntries, { level: 6 }), 'application/zip');
    } else {
      addDownload('下载新的 system', 'system', result.bytes, 'application/octet-stream');
    }
    addDownload('下载 report.json', 'report.json', enc.encode(reportJson), 'application/json');

    elements.resultPanel.hidden = false;
    const warnings = [
      ...(result.reports.dlc?.warnings || []),
      ...(result.reports.palico?.warnings || []),
    ];
    setStatus(warnings.length
      ? `处理完成，但有 ${warnings.length} 条警告，请查看报告。`
      : '处理完成。请用 Checkpoint 导入，并先保留原始备份。',
      warnings.length ? '' : 'good');
  } catch (error) {
    setStatus(`处理失败：${error.message}`, 'bad');
  } finally {
    state.processing = false;
    updateCapacity();
  }
}

function bindDropzone(dropzone, input, handler) {
  ['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('drag');
    });
  });
  dropzone.addEventListener('drop', (event) => {
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    try {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      input.files = transfer.files;
    } catch {
      // The dropped file is still passed to the handler below.
    }
    handler(files[0]);
  });
}

elements.targetFile.addEventListener('change', () => loadTarget(elements.targetFile.files[0]));
elements.run.addEventListener('click', run);
elements.mergeCats.addEventListener('change', updateCapacity);
elements.keepCatLevel.addEventListener('change', updateCapacity);
elements.selectAllCatSlots.addEventListener('click', () => {
  state.selectedCatSlots = new Set((state.target?.active || []).map((character) => character.index));
  renderCatSlotPicker();
  updateCapacity();
});
elements.selectNoCatSlots.addEventListener('click', () => {
  state.selectedCatSlots.clear();
  renderCatSlotPicker();
  updateCapacity();
});
elements.selectAllCats?.addEventListener('click', () => {
  resetCatSelection(state.catSources);
  renderCatPicker();
});
elements.selectNoCats?.addEventListener('click', () => {
  state.selectedCats.clear();
  renderCatPicker();
});
bindDropzone(elements.targetDrop, elements.targetFile, (file) => loadTarget(file));

renderCatSlotPicker();
renderCatPicker();
updateCapacity();
loadContent();
