const CACHE_VERSION='1.12.1';
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.json','./cloud-sync.js','./update-manager.js','./version.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png','./favicon-32.png','./logo-lidl.jpeg','./logo-hofer.jpeg','./logo-spar.png','./logo-mercator.png','./logo-dm.jpeg','./logo-tus.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_VERSION).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_VERSION).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  const isImage=/\.(png|jpe?g|svg|webp|ico)$/i.test(url.pathname);
  if(isImage){
    event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE_VERSION).then(cache=>cache.put(event.request,copy));return response;})));
    return;
  }
  event.respondWith(fetch(event.request,{cache:'no-store'}).then(response=>{const copy=response.clone();caches.open(CACHE_VERSION).then(cache=>cache.put(event.request,copy));return response;}).catch(()=>caches.match(event.request).then(cached=>cached||caches.match('./index.html'))));
});
