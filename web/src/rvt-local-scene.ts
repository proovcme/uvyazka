/** Same-origin native reader for the installed app and the loopback dashboard. */
export async function readLocalRvtScene(
  base:string, bytes:Uint8Array<ArrayBuffer>, sourceHash:string, start:()=>void
) {
  const url = new URL('/api/models/rvt-scene', base);
  const configResponse = await fetch(url);
  if (configResponse.status === 404) return null;
  if (!configResponse.ok) throw Error('Не удалось проверить локальный читатель RVT.');
  const config = await configResponse.json();
  if (!config.available || bytes.byteLength > config.max_bytes) return null;
  start();
  const response = await fetch(url, {
    method:'POST',
    headers:{
      'Content-Type':'application/octet-stream',
      'X-Uvyazka-Token':config.token,
      'X-Uvyazka-Source-Sha256':sourceHash,
    },
    body:bytes,
  });
  if (!response.ok) throw Error((await response.json()).error || 'Не удалось прочитать сохранённую графику RVT.');
  const reader = response.headers.get('X-Uvyazka-Reader-Sha256') || '';
  if (response.headers.get('X-Uvyazka-Source-Sha256') !== sourceHash || !/^[a-f0-9]{64}$/.test(reader)) {
    throw Error('Локальная сцена RVT относится к другому источнику.');
  }
  const packet = await response.arrayBuffer();
  if (packet.byteLength < 5) throw Error('Получен неполный результат чтения RVT.');
  const size = new DataView(packet).getUint32(0,true);
  const end = 4+size;
  if (!size || size>128*1024**2 || end>=packet.byteLength || packet.byteLength-end>512*1024**2) {
    throw Error('Неверный размер результата RVT.');
  }
  const manifest = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(packet,4,size)));
  return {reader, manifest, geometry_binary:new Uint8Array(packet,end)};
}
