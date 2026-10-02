import React from 'react';
import { EditorIcon } from './EditorIcon';
import type { Artifact, Recipe, Source } from '../../../packages/contracts/src/index';

type Props = {
  recipe: Recipe;
  audio: (patch: Partial<Recipe['audio']>) => void;
  artifact?: Artifact;
  sources: Source[];
  artifacts: Artifact[];
  duration: number;
};

const fill = (value: number, min: number, max: number) => ({ '--p': `${Math.max(0, Math.min(1, (value - min) / (max - min))) * 100}%` }) as React.CSSProperties;

function Slider({ label, value, min, max, step, unit, format, onChange, numberLabel }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; format: (v: number) => string; onChange: (v: number) => void; numberLabel: string;
}) {
  return <div className="audio-slider">
    <div className="audio-slider-head"><span>{label}</span><span className="audio-value">{format(value)}</span></div>
    <input type="range" aria-label={`${label} slider`} min={min} max={max} step={step} value={Math.min(max, value)} style={fill(value, min, max)} onChange={event => onChange(Number(event.target.value))} />
    <label className="audio-number"><input aria-label={numberLabel} type="number" min={0} step="any" value={value} onChange={event => onChange(event.target.valueAsNumber || 0)} /><em>{unit}</em></label>
  </div>;
}

export function AudioInspector({ recipe, audio, artifact, sources, artifacts, duration }: Props) {
  const tracks = artifact?.media.streams.filter(stream => stream.type === 'audio') || [];
  const mode = recipe.audio.mode;
  const removed = mode === 'mute';
  const external = mode === 'replace' || mode === 'mix';
  const sourceMode = removed ? 'remove' : external ? 'other' : 'keep';
  const fadeMax = Math.max(1, Math.min(60, Math.floor(duration / 2)));
  const candidates = sources.filter(source => artifacts.find(item => item.id === source.artifactId)?.media.streams.some(stream => stream.type === 'audio'));
  const percent = Math.round(recipe.audio.volume * 100);
  const choices: [string, string, string, () => void][] = [
    ['keep', 'Keep', 'volume', () => audio({ mode: 'keep' })],
    ['remove', 'Remove', 'mute', () => audio({ mode: 'mute' })],
    ['other', 'Replace', 'audio', () => audio({ mode: external ? mode : 'replace' })],
  ];
  return <div className="audio-inspector">
    <div className="audio-card">
      <div className="audio-card-head">Source audio</div>
      <div className="audio-segments" role="group" aria-label="Audio handling">
        {choices.map(([value, text, icon, action]) => <button key={value} className="audio-segment" aria-pressed={sourceMode === value} onClick={action}><span>{text}</span></button>)}
      </div>
      {removed && <p className="audio-note">The exported video will have no audio track.</p>}
      {sourceMode === 'keep' && tracks.length > 1 && <label className="audio-field">Audio track
        <select aria-label="Audio track" value={recipe.audio.track} onChange={event => audio({ track: Number(event.target.value) })}>
          {tracks.map((stream, i) => <option key={stream.index} value={i}>Track {i + 1} · {stream.codec} · {stream.channels} ch</option>)}
        </select>
      </label>}
      {sourceMode === 'keep' && tracks.length === 1 && <p className="audio-note">Track 1 · {tracks[0].codec} · {tracks[0].channels} channels</p>}
      {sourceMode === 'keep' && !tracks.length && <p className="audio-note">This source has no audio track.</p>}
      {external && <>
        <div className="audio-segments audio-segments-small" role="group" aria-label="Additional audio mode">
          <button className="audio-segment" aria-pressed={mode === 'replace'} onClick={() => audio({ mode: 'replace' })}><span>Replace original</span></button>
          <button className="audio-segment" aria-pressed={mode === 'mix'} onClick={() => audio({ mode: 'mix' })}><span>Mix with original</span></button>
        </div>
        <label className="audio-field">Additional audio source
          <select aria-label="Additional audio source" value={recipe.audio.sourceId || ''} onChange={event => audio({ sourceId: event.target.value || undefined })}>
            <option value="">Select an imported audio source</option>
            {candidates.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}
          </select>
        </label>
      </>}
    </div>

    {!removed && <>
      <div className="audio-card">
        <div className="audio-card-head">Level</div>
        <Slider label="Volume" value={recipe.audio.volume} min={0} max={2} step={.01} unit="×" numberLabel="Volume multiplier" format={v => `${Math.round(v * 100)}%`} onChange={v => audio({ volume: Math.max(0, Math.min(10, v)) })} />
        <div className="audio-quick" role="group" aria-label="Volume presets">
          {[[0, 'Mute'], [.5, '50%'], [1, '100%'], [1.5, '150%']].map(([value, text]) => <button key={text} aria-pressed={recipe.audio.volume === value} onClick={() => audio({ volume: value as number })}>{text}</button>)}
        </div>
        {percent > 100 && <p className="audio-note">Above 100% can clip loud passages. Loudness normalization may help.</p>}
      </div>

      <div className="audio-card">
        <div className="audio-card-head">Fades</div>
        <Slider label="Fade in" value={recipe.audio.fadeIn} min={0} max={fadeMax} step={.1} unit="s" numberLabel="Fade in (s)" format={v => `${v.toFixed(1)} s`} onChange={v => audio({ fadeIn: Math.max(0, Math.min(60, v)) })} />
        <Slider label="Fade out" value={recipe.audio.fadeOut} min={0} max={fadeMax} step={.1} unit="s" numberLabel="Fade out (s)" format={v => `${v.toFixed(1)} s`} onChange={v => audio({ fadeOut: Math.max(0, Math.min(60, v)) })} />
      </div>

      <label className="audio-switch">
        <input type="checkbox" role="checkbox" aria-label="Loudness normalization" checked={recipe.audio.normalize} onChange={event => audio({ normalize: event.target.checked })} />
        <i aria-hidden="true" />
        <span><strong>Even out volume</strong><small>Normalize loudness so quiet and loud parts sound consistent.</small></span>
      </label>

      <button className="audio-reset" disabled={recipe.audio.volume === 1 && !recipe.audio.fadeIn && !recipe.audio.fadeOut && !recipe.audio.normalize} onClick={() => audio({ volume: 1, fadeIn: 0, fadeOut: 0, normalize: false })}><EditorIcon name="reset" size={15} />Reset audio settings</button>
    </>}
  </div>;
}
