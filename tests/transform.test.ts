import assert from 'node:assert/strict';
import test from 'node:test';
import { angle, clampCrop, dragCrop, outputSize, sourcePoint, viewportGeometry } from '../apps/web/src/transform.ts';

test('crop stays inside encoded source pixels', () => {
  assert.deepEqual(clampCrop({x:600,y:-10,width:500,height:400},640,360),{x:140,y:0,width:500,height:360});
  assert.deepEqual(dragCrop({x:80,y:40,width:480,height:240},'move',1000,-1000,640,360),{x:160,y:0,width:480,height:240});
  assert.deepEqual(dragCrop({x:80,y:40,width:480,height:240},'nw',600,300,640,360),{x:559,y:279,width:1,height:1});
});

test('output dimensions follow crop, source orientation, rotation, then resize', () => {
  const recipe = {crop:{x:10,y:20,width:401,height:301},rotate:90 as const};
  assert.deepEqual(outputSize(recipe,640,360),{width:300,height:400});
  assert.deepEqual(outputSize(recipe,640,360,90),{width:400,height:300});
  assert.deepEqual(outputSize({...recipe,resize:{width:200,height:600}},640,360),{width:200,height:600});
  assert.equal(angle(-90),270);
});

test('rotated, stretched, cropped preview maps back to exact source coordinates', () => {
  for (const rotate of [0,90,180,270] as const) for (const sourceRotation of [0,90,-90,180]) {
    const recipe = {crop:{x:80,y:40,width:480,height:240},rotate,resize:{width:200,height:300}};
    const geometry = viewportGeometry(recipe,640,360,800,500,false,false,sourceRotation);
    assert(Math.abs(geometry.width/geometry.height-2/3)<1e-10);
    for (const [sourceX,sourceY] of [[80,40],[560,40],[80,280],[560,280],[320,180]]) {
      const matrix = geometry.transform;
      const viewportX=matrix.a*sourceX+matrix.c*sourceY+matrix.x;
      const viewportY=matrix.b*sourceX+matrix.d*sourceY+matrix.y;
      const point=sourcePoint(matrix,viewportX,viewportY);
      assert(Math.abs(point.x-sourceX)<1e-8);
      assert(Math.abs(point.y-sourceY)<1e-8);
      assert(viewportX>=-1e-8&&viewportX<=geometry.width+1e-8);
      assert(viewportY>=-1e-8&&viewportY<=geometry.height+1e-8);
    }
  }
});

test('crop editing keeps the whole source available rather than clipping it to the result', () => {
  const recipe={crop:{x:80,y:40,width:480,height:240},rotate:90 as const,resize:{width:200,height:300}};
  const geometry=viewportGeometry(recipe,640,360,800,500,true,false);
  assert.deepEqual(geometry.output,{width:360,height:640});
  assert.equal(geometry.top,0);
});
