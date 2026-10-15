import http from 'node:http';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.wasm':'application/wasm', '.webmanifest':'application/manifest+json', '.txt':'text/plain' };
const denied = /^(?:\.|node_modules$|credentials?(?:\.|$)|secrets?(?:\.|$)|auth(?:\.|$)|tokens?(?:\.|$)|service[-_]?accounts?(?:\.|$)|id_rsa|id_ed25519)/i;
async function safeFile(root, relative) {
  if (await realpath(root) !== root) throw new Error('The preview folder changed.');
  const parts = relative.split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '..' || denied.test(p) || p.includes('\\') || p.includes('\0'))) throw new Error('This file is not available in preview.');
  let file = root;
  for (const part of parts) {
    file = path.join(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Linked files are not available in preview.');
  }
  const info = await lstat(file);
  if (!info.isFile() || info.size > 20 * 1024 * 1024 || !types[path.extname(file).toLowerCase()]) throw new Error('This file is not available in preview.');
  return file;
}
async function readPreviewFile(root, filename) {
  // Keep reads pinned to a normal file, then verify it did not move through a
  // symlink or outside the selected folder while a build changed the project.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 20 * 1024 * 1024 || await realpath(root) !== root || await realpath(filename) !== filename) throw new Error('The preview file changed.');
    const bytes = await handle.readFile();
    const after = await handle.stat(), current = await lstat(filename);
    if (bytes.length > 20 * 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || await realpath(filename) !== filename || await realpath(root) !== root) throw new Error('The preview file changed.');
    return bytes;
  } finally { await handle.close(); }
}
export async function previewRoot(project, { builtAfter } = {}) {
  if ((await lstat(project)).isSymbolicLink()) throw new Error('Choose the original project folder to preview; linked folders are not supported.');
  project = await realpath(project);
  // Only built/static documents. Never start project scripts or install dependencies.
  for (const subdir of ['dist', 'build', 'out', '', 'public']) {
    const base = path.join(project, subdir);
    try {
      if ((await lstat(base)).isSymbolicLink()) continue;
      const entry = await safeFile(base, 'index.html');
      if (['dist', 'build', 'out'].includes(subdir) && builtAfter && (await lstat(entry)).mtimeMs < Date.parse(builtAfter)) continue;
      const html = (await readPreviewFile(base, entry)).toString('utf8');
      if (/<script\b[^>]*src\s*=\s*["'][^"']*\.(?:tsx|ts|jsx)(?:[?"'])/i.test(html)) continue;
      return { root: base, label: subdir ? `Web preview · ${subdir}` : 'Web preview' };
    } catch {}
  }
  throw new Error(`${builtAfter ? 'This project was restored; earlier generated pages cannot preview the restored source. ' : ''}No built web page is ready yet. Ask Duet to create or build an index.html preview. Apps that need a running backend are not supported by this preview yet.`);
}
export function createPreviewManager() {
  const running = new Map(), starting = new Map();
  let closing = false;
  const status = id => running.get(id)?.info ?? {status:'stopped'};
  async function stop(id) {
    if (starting.has(id)) await starting.get(id).catch(()=>{});
    const current = running.get(id); if (!current) return {status:'stopped'};
    running.delete(id);
    current.server.closeAllConnections();
    await new Promise(resolve => current.server.close(resolve));
    return {status:'stopped'};
  }
  async function start(id, project, { appOrigin, builtAfter } = {}) {
    if (closing) throw new Error('Duet is closing. Reopen it to preview your app.');
    if (running.has(id)) return status(id);
    if (starting.has(id)) return starting.get(id);
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(appOrigin)) throw new Error('Invalid workspace origin.');
    const task = (async()=>{
      const selected = await previewRoot(project, { builtAfter });
      const server = http.createServer(async(req,res)=>{
        res.setHeader('Cache-Control','no-store');
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy', `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self'; frame-ancestors ${appOrigin}; base-uri 'self'; form-action 'none'; object-src 'none'`);
        const reply=(code,text)=>{res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});res.end(text);};
        try {
          if(req.headers.host !== `localhost:${server.address().port}`) return reply(403,'Invalid preview host.');
          if(!['GET','HEAD'].includes(req.method)) return reply(405,'This preview is read-only.');
          let relative = decodeURIComponent(req.url.split('?')[0]);
          if (relative.endsWith('/')) relative += 'index.html';
          const file=await safeFile(selected.root,relative);
          const bytes=await readPreviewFile(selected.root,file);
          const type = types[path.extname(file).toLowerCase()];
          res.writeHead(200,{'Content-Type':type + (/^(?:text\/|application\/(?:json|manifest\+json))/.test(type) ? '; charset=utf-8' : '')});res.end(req.method==='HEAD'?undefined:bytes);
        } catch {reply(404,'This file is not available in preview.');}
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const info={status:'running',kind:'static',label:selected.label,url:`http://localhost:${server.address().port}/`,note:'Local web preview. Backend services, external API requests, and form submissions are not started here.'};
      running.set(id,{server,info});
      if(closing) {running.delete(id);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw new Error('Duet is closing.');}
      return info;
    })();
    starting.set(id,task);
    try {return await task;} finally {starting.delete(id);}
  }
  return {status,start,stop,async close(){closing=true;await Promise.allSettled([...starting.values()]);await Promise.all([...running.keys()].map(stop));}};
}
