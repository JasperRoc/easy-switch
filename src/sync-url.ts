export function syncURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use an HTTPS sync URL, or HTTP on localhost.'); }
  if (url.username || url.password || url.search || url.hash || !url.hostname ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('Use an HTTPS sync URL, or HTTP on localhost.');
  return url.href.replace(/\/*$/, '/');
}

export function webdavLibraryURL(value, savedURL) {
  const url = syncURL(value);
  // A previously verified custom folder continues to use the same library.
  if (url === savedURL || savedURL && (url + 'fluid/' === savedURL)) return savedURL;
  const last = new URL(url).pathname.slice(0, -1).split('/').at(-1);
  let folder = last;
  try { folder = decodeURIComponent(last); } catch {}
  return folder === 'fluid' ? url : url + 'fluid/';
}
