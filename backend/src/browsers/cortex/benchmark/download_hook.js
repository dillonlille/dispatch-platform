(() => {
  if (globalThis.__dispatchDownloads) return 'already';
  const log = (globalThis.__dispatchDownloads = []);
  const mask = (s) => (/\d/.test(s) || s.length > 32 ? '{id}' : s);
  const where = (value) => {
    const u = new URL(String(value), location.href);
    return {
      scheme: u.protocol,
      host: u.protocol === 'https:' ? u.host : '',
      path: u.protocol === 'data:' ? '' : u.pathname.split('/').map(mask).join('/'),
    };
  };
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    try {
      if (object instanceof Blob) {
        const record = { kind: 'blob', type: object.type, size: object.size };
        log.push(record);
        if (object.size <= 8 * 1024 * 1024) {
          const reader = new FileReader();
          reader.onload = () => {
            record.base64 = String(reader.result).split(',')[1] || '';
          };
          reader.readAsDataURL(object);
        }
      }
    } catch {}
    return createObjectURL.apply(this, arguments);
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const record = {
        kind: 'anchor',
        ...where(this.href),
        download: this.hasAttribute('download'),
      };
      if (this.href.startsWith('data:') && this.href.length <= 11 * 1024 * 1024)
        record.dataUrl = this.href;
      log.push(record);
    } catch {}
    return click.apply(this, arguments);
  };
  const open = window.open;
  window.open = function (url) {
    try {
      log.push({ kind: 'open', ...where(url) });
    } catch {}
    return open.apply(this, arguments);
  };
  return 'hooked';
})();
