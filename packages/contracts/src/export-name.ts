const mediaExtension = /(?:\.(?:mp4|mkv|mov|webm|avi|m4v|mpeg|mpg|mts|m2ts|ts|wmv|flv|3gp|mp3|m4a|aac|wav|flac|ogg|opus))+$/i;
const stem = (name: string) => name.trim().replace(mediaExtension, '');
const clean = (name: string) => {
  const value = name.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  let result = '';
  for (const character of value) { if (result.length + character.length > 150) break; result += character; }
  result = result.replace(/[. ]+$/, '');
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(result) ? `_${result}` : result;
};

export function defaultExportStem(sourceName: string) { return `${clean(stem(sourceName)) || 'media'}-edit`; }
export function exportFileName(name: string | undefined, sourceName: string, container: 'mp4' | 'mkv') {
  return `${clean(stem(name || '')) || clean(defaultExportStem(sourceName))}.${container}`;
}
export function availableExportName(name: string, taken: Iterable<string>) {
  const used = new Set(Array.from(taken, value => value.normalize('NFC').toLowerCase()));
  const dot = name.lastIndexOf('.'), base = name.slice(0, dot), extension = name.slice(dot);
  let candidate = name, revision = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${revision++})${extension}`;
  return candidate;
}
