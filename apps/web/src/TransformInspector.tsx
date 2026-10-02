import React, { useState } from 'react';
import { EditorIcon } from './EditorIcon';
import { SizeInput, even, presets } from './TransformViewport';
import { angle, clampCrop, outputSize } from './transform';
import type { Recipe } from '../../../packages/contracts/src/index';

type Props = { recipe: Recipe; change: (recipe: Recipe) => void; width: number; height: number; sourceRotation: number };

const ratios: [string, number | undefined][] = [['Free', undefined], ['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['9:16', 9 / 16]];

export function TransformInspector({ recipe, change, width, height, sourceRotation }: Props) {
  const [locked, setLocked] = useState(true);
  const swapped = angle(recipe.rotate - sourceRotation) % 180 === 90;
  const output = outputSize(recipe, width, height, sourceRotation);
  const natural = outputSize({ ...recipe, resize: undefined }, width, height, sourceRotation);
  const ratio = natural.width / natural.height;
  const setResize = (next?: { width: number; height: number }) => change({ ...recipe, resize: next && (next.width === natural.width && next.height === natural.height ? undefined : next) });
  const setWidth = (value: number) => setResize({ width: even(value), height: locked ? even(value / ratio) : output.height });
  const setHeight = (value: number) => setResize({ width: locked ? even(value * ratio) : output.width, height: even(value) });
  const scaled = (factor: number) => setResize({ width: even(natural.width * factor), height: even(natural.height * factor) });
  const rotate = (value: number) => change({ ...recipe, rotate: angle(value) as Recipe['rotate'] });
  const crop = recipe.crop;
  const setCrop = (patch: Partial<NonNullable<Recipe['crop']>>) => change({ ...recipe, crop: clampCrop({ ...(crop || { x: 0, y: 0, width, height }), ...patch }, width, height) });
  const applyRatio = (target?: number) => {
    if (!target) return;
    const wanted = swapped ? 1 / target : target;
    let w = width, h = Math.round(w / wanted);
    if (h > height) { h = height; w = Math.round(h * wanted); }
    change({ ...recipe, crop: clampCrop({ x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h }, width, height) });
  };
  const heights = [1080, 720, 480].filter(h => h < natural.height);
  const activePreset = presets.find(([, factor]) => even(natural.width * factor) === output.width && even(natural.height * factor) === output.height)?.[1];

  return <div className="transform-inspector">
    <div className="audio-card">
      <div className="ti-head"><div className="audio-card-head">Crop</div>
        <button className="ti-switch" role="switch" aria-label="Crop" aria-checked={!!crop} onClick={() => change({ ...recipe, crop: crop ? undefined : { x: 0, y: 0, width, height } })}><i aria-hidden="true" /></button>
      </div>
      {crop ? <>
        <div className="ti-chips" role="group" aria-label="Crop aspect ratio">
          {ratios.filter(([, value]) => value).map(([label, value]) => <button key={label} onClick={() => applyRatio(value)}>{label}</button>)}
          <button onClick={() => change({ ...recipe, crop: { x: 0, y: 0, width, height } })}>Full</button>
        </div>
        <div className="ti-grid">
          {(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}><span>{key === 'x' ? 'X' : key === 'y' ? 'Y' : key === 'width' ? 'Width' : 'Height'}</span>
            <input aria-label={`Crop ${key}`} type="number" min={key === 'x' || key === 'y' ? 0 : 1} step={1} value={crop[key]} onChange={event => { const v = event.target.valueAsNumber; if (Number.isFinite(v)) setCrop({ [key]: v }); }} /></label>)}
        </div>
      </> : <p className="audio-note">Turn on crop to pick an area to keep, then drag the frame in the viewer.</p>}
    </div>

    <div className="audio-card">
      <div className="audio-card-head">Rotate</div>
      <div className="ti-rotate">
        <button className="ti-round" aria-label="Rotate left" title="Rotate left 90°" onClick={() => rotate(recipe.rotate - 90)}><EditorIcon name="rotate-left" size={17} /></button>
        <div className="audio-segments" role="group" aria-label="Clockwise rotation">
          {[0, 90, 180, 270].map(value => <button key={value} className="audio-segment" aria-pressed={recipe.rotate === value} onClick={() => rotate(value)}><span>{value}°</span></button>)}
        </div>
        <button className="ti-round" aria-label="Rotate right" title="Rotate right 90°" onClick={() => rotate(recipe.rotate + 90)}><EditorIcon name="rotate-right" size={17} /></button>
      </div>
    </div>

    <div className="audio-card">
      <div className="ti-head"><div className="audio-card-head">Resize</div>
        <button className="ti-switch" role="switch" aria-label="Resize" aria-checked={!!recipe.resize} onClick={() => recipe.resize ? setResize(undefined) : setResize({ width: even(natural.width / 2), height: even(natural.height / 2) })}><i aria-hidden="true" /></button>
      </div>
      <div className="ti-chips" role="group" aria-label="Resize presets">
        <button aria-pressed={!recipe.resize} onClick={() => setResize(undefined)}>Original</button>
        {presets.slice(1).map(([label, factor]) => <button key={label} aria-pressed={!!recipe.resize && activePreset === factor} onClick={() => scaled(factor)}>{label}</button>)}
        {heights.map(h => <button key={h} aria-pressed={recipe.resize?.height === h} onClick={() => setHeight(h)}>{h}p</button>)}
      </div>
      <div className="ti-size">
        <label><span>Width</span><SizeInput label="Output width" value={output.width} onCommit={setWidth} /></label>
        <button className="ti-round" aria-label="Lock aspect ratio" aria-pressed={locked} title={locked ? 'Aspect ratio locked' : 'Aspect ratio unlocked'} onClick={() => setLocked(!locked)}><EditorIcon name={locked ? 'lock' : 'unlock'} size={16} /></button>
        <label><span>Height</span><SizeInput label="Output height" value={output.height} onCommit={setHeight} /></label>
      </div>
      <p className="audio-note">Output {output.width} × {output.height}{recipe.resize ? ` (from ${natural.width} × ${natural.height})` : ''}</p>
    </div>
  </div>;
}
