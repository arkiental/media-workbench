import {readFile,writeFile} from 'node:fs/promises';
const evidence=JSON.parse(await readFile(new URL('./evidence.json',import.meta.url),'utf8'));
const captions={
 '01-import':'Import and download compete with eight peer navigation destinations.',
 '02-editor-empty':'Editor empty state gives instructions but no direct import action.',
 '03-editor-viewport':'At 1440 × 900 the initial view does not reach region in/out fields.',
 '04-editor-full':'The initial editor is 2,804 px tall: viewer, tools and export are separated by scrolling.',
 '05-export-plan':'Many technical choices precede the plan and final export action.',
 '06-rendered-preview':'This is a real rendered output, not a simulation of the source player.',
 '07-queue':'Opaque job IDs and generic export names reduce recognition.',
 '08-library':'Preview and export produce two visually indistinguishable clip.mp4 entries.',
 '09-presets':'JSON preset editing and saved projects share one destination.',
 '10-integrations':'Browser capability limitations and credentials share a page; native actions were not exercised.',
 '11-settings':'Diagnostics and encoder details form another long page.',
 '12-administration':'Owner operations are exposed at the main navigation level.',
 '13-editor-mobile':'No horizontal page overflow was observed, but the editor becomes a long vertical workflow.'
};
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media Workbench — current UI audit</title><style>
body{font:16px/1.55 system-ui,sans-serif;color:#20252b;background:#f4f5f6;margin:0}main{max-width:1160px;margin:auto;padding:32px 24px}h1{font-size:28px;margin:0}p{max-width:850px}a{color:#245ca6}nav{display:flex;flex-wrap:wrap;gap:14px;margin:24px 0}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:28px}figure{margin:0;background:white;border:1px solid #d8dde3;padding:14px}img{display:block;width:100%;height:290px;object-fit:contain;object-position:top;background:#eceff2}figcaption{padding:12px 0 0}strong{display:block}small{color:#59636f}a:focus-visible{outline:3px solid #245ca6;outline-offset:4px}</style><main><h1>Media Workbench · current UI</h1><p>13 fresh captures from an isolated instance of the current application, 18 September 2026. Desktop browser viewport: 1440 × 900. Mobile: 390 × 844. Click a screenshot to inspect it at full resolution.</p><nav><a href="REPORT.md">Read findings and design recommendations</a><a href="evidence.json">View walkthrough evidence</a></nav><div class="gallery">${evidence.screens.map(s=>`<figure><a href="screenshots/${s.name}.png"><img loading="lazy" src="screenshots/${s.name}.png" alt="${esc(captions[s.name])}"></a><figcaption><strong>${esc(s.name.replaceAll('-',' '))}</strong>${esc(captions[s.name])}<br><small>Document height at capture: ${s.height} px</small></figcaption></figure>`).join('')}</div></main></html>`;
await writeFile(new URL('./gallery.html',import.meta.url),html);
