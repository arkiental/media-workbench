import { cloneElement, isValidElement, useId, type ReactNode, type ReactElement } from 'react';

export function Field({ label, children, help }: { label:string; children:ReactNode; help?:string }) {
  const id=useId();
  return <div className="field"><label htmlFor={id}>{label}</label>{isValidElement(children)?cloneElement(children as ReactElement<Record<string,unknown>>,{id,...(help?{'aria-describedby':`${id}-help`}:{})}):children}{help && <small id={`${id}-help`}>{help}</small>}</div>;
}
export function Panel({ title, children }: { title:string; children:ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}
export function NumberField({ label,value,onChange,min,max,step = 'any',disabled=false }: { label:string; value:number; onChange:(v:number)=>void; min?:number; max?:number; step?:number|'any'; disabled?:boolean }) {
  return <Field label={label}><input type="number" value={Number.isFinite(value)?value:0} min={min} max={max} step={step} disabled={disabled} onChange={e=>onChange(e.target.valueAsNumber || 0)}/></Field>;
}
export function Checkbox({ label,value,onChange }: { label:string; value:boolean; onChange:(v:boolean)=>void }) {
  return <label className="check"><input type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)}/>{label}</label>;
}
export function bytes(n:number): string { return n < 1_000_000 ? `${(n/1000).toFixed(1)} kB` : `${(n/1_000_000).toFixed(2)} MB`; }
