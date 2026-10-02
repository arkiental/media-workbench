import type { Recipe } from '../../../packages/contracts/src/index';
import { captionLayout } from '../../../packages/contracts/src/caption';

export type Crop = NonNullable<Recipe['crop']>;
export type Matrix = { a:number; b:number; c:number; d:number; x:number; y:number };
export const angle = (degrees:number) => ((degrees % 360) + 360) % 360;

export function rotationMatrix(degrees:number, width:number, height:number):Matrix {
  switch (angle(degrees)) {
    case 90: return { a:0, b:1, c:-1, d:0, x:height, y:0 };
    case 180: return { a:-1, b:0, c:0, d:-1, x:width, y:height };
    case 270: return { a:0, b:-1, c:1, d:0, x:0, y:width };
    default: return { a:1, b:0, c:0, d:1, x:0, y:0 };
  }
}

export function clampCrop(crop:Crop, width:number, height:number):Crop {
  const cropWidth = Math.max(1, Math.min(width, Math.round(crop.width)));
  const cropHeight = Math.max(1, Math.min(height, Math.round(crop.height)));
  return { x:Math.max(0, Math.min(width-cropWidth, Math.round(crop.x))), y:Math.max(0, Math.min(height-cropHeight, Math.round(crop.y))), width:cropWidth, height:cropHeight };
}

export function outputSize(recipe:Pick<Recipe,'crop'|'rotate'|'resize'>, width:number, height:number, sourceRotation=0) {
  const crop = clampCrop(recipe.crop || { x:0, y:0, width, height }, width, height);
  const swapped = angle(recipe.rotate-sourceRotation) % 180 === 90;
  return { width:recipe.resize?.width || Math.max(2, Math.floor((swapped ? crop.height : crop.width)/2)*2), height:recipe.resize?.height || Math.max(2, Math.floor((swapped ? crop.width : crop.height)/2)*2) };
}

export function viewportGeometry(recipe:Pick<Recipe,'crop'|'rotate'|'resize'|'caption'>, width:number, height:number, viewportWidth:number, viewportHeight:number, editingCrop:boolean, fill:boolean, sourceRotation=0) {
  const crop = editingCrop ? { x:0, y:0, width, height } : clampCrop(recipe.crop || { x:0, y:0, width, height }, width, height);
  const rotation = angle(recipe.rotate-sourceRotation);
  const swapped = rotation % 180 === 90;
  const rotatedWidth = swapped ? crop.height : crop.width;
  const rotatedHeight = swapped ? crop.width : crop.height;
  const picture = editingCrop ? { width:rotatedWidth, height:rotatedHeight } : outputSize(recipe,width,height,sourceRotation);
  const header=captionLayout(editingCrop?undefined:recipe.caption,picture.width);
  const output={width:picture.width,height:picture.height+header.height};
  const scale = (fill && !editingCrop ? Math.max : Math.min)(viewportWidth/output.width, viewportHeight/output.height);
  const scaleX = scale*picture.width/rotatedWidth;
  const scaleY = scale*picture.height/rotatedHeight;
  const matrix = rotationMatrix(rotation,crop.width,crop.height);
  const transform = { a:matrix.a*scaleX, b:matrix.b*scaleY, c:matrix.c*scaleX, d:matrix.d*scaleY, x:(matrix.x-matrix.a*crop.x-matrix.c*crop.y)*scaleX, y:(matrix.y-matrix.b*crop.x-matrix.d*crop.y)*scaleY+header.height*scale };
  return { width:output.width*scale, height:output.height*scale, left:(viewportWidth-output.width*scale)/2, top:(viewportHeight-output.height*scale)/2, transform, output, header, scale };
}

export function sourcePoint(matrix:Matrix, x:number, y:number) {
  const determinant = matrix.a*matrix.d-matrix.b*matrix.c;
  return { x:(matrix.d*(x-matrix.x)-matrix.c*(y-matrix.y))/determinant, y:(matrix.a*(y-matrix.y)-matrix.b*(x-matrix.x))/determinant };
}

export function dragCrop(crop:Crop, handle:string, dx:number, dy:number, width:number, height:number):Crop {
  if (handle==='move') return clampCrop({ ...crop, x:crop.x+dx, y:crop.y+dy },width,height);
  let left=crop.x, top=crop.y, right=crop.x+crop.width, bottom=crop.y+crop.height;
  if (handle.includes('w')) left=Math.max(0,Math.min(right-1,Math.round(left+dx)));
  if (handle.includes('e')) right=Math.max(left+1,Math.min(width,Math.round(right+dx)));
  if (handle.includes('n')) top=Math.max(0,Math.min(bottom-1,Math.round(top+dy)));
  if (handle.includes('s')) bottom=Math.max(top+1,Math.min(height,Math.round(bottom+dy)));
  return { x:left, y:top, width:right-left, height:bottom-top };
}
