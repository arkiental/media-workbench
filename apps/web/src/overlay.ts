import type { Overlay, OverlayImage, Recipe } from '../../../packages/contracts/src/index';
import { ApiError } from './api';

export const MAX_OVERLAYS = 20;
const MAX_SIDE = 4096, DEFAULT_SECONDS = 5;

export const overlayUrl = (id:string) => `/api/v1/overlays/${id}/content`;

// Any browser-decodable image (file, paste or drop) is re-encoded as PNG so the server sees one format and transparency survives.
export async function uploadOverlayImage(blob:Blob, name:string):Promise<OverlayImage> {
  let bitmap:ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { throw new Error('That file is not an image this browser can read.'); }
  const scale = Math.min(1, MAX_SIDE/Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width*scale)); canvas.height = Math.max(1, Math.round(bitmap.height*scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('The image could not be prepared.')), 'image/png'));
  const response = await fetch('/api/v1/overlays', {method:'POST', credentials:'same-origin', headers:{'content-type':'image/png','x-filename':encodeURIComponent(name.slice(0,200) || 'Image')}, body:png});
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new ApiError(error.error || `Image upload failed (${response.status})`, response.status); }
  return response.json();
}

/** A new overlay starts at the playhead, lasts a few seconds and fits within roughly half the picture. */
export function newOverlay(image:OverlayImage, time:number, duration:number, picture:{width:number;height:number}):Overlay {
  const length = Math.min(DEFAULT_SECONDS, duration);
  const start = Math.max(0, Math.min(time, duration-length));
  const fitHeight = .5*picture.height/picture.width*image.width/image.height;
  return {imageId:image.id, name:image.name.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 200) || 'Image', in:start, out:Math.min(duration, start+length), x:.5, y:.5, width:Math.max(.02, Math.min(.4, fitHeight)), opacity:1};
}

export const visibleAt = (overlay:Overlay, time:number) => time >= overlay.in && time < overlay.out;

/** Overlapping overlays get separate lanes so every clip stays clickable on the timeline. */
export function overlayLanes(overlays:Recipe['overlays']) {
  const ends:number[] = [], lanes:number[] = [];
  overlays.map((o, i) => ({o, i})).sort((a, b) => a.o.in-b.o.in || a.i-b.i).forEach(({o, i}) => {
    let lane = ends.findIndex(end => end <= o.in + 1e-6);
    if (lane < 0) lane = ends.length;
    ends[lane] = o.out; lanes[i] = lane;
  });
  return {lanes, count:Math.max(1, ends.length)};
}

export function imageFromClipboard(data:DataTransfer|null):File|undefined {
  const items = Array.from(data?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile());
  return items.find(Boolean) || Array.from(data?.files || []).find(file => file.type.startsWith('image/'));
}
