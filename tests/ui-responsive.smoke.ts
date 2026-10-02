import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, runProcess } from '../packages/media/src/index.ts';

const evidenceDir = path.resolve('test-output/responsive');
await mkdir(evidenceDir, { recursive: true });
const tools = await discoverTools();
const fixture = path.join(evidenceDir, 'touch-fixture.mp4');
await runProcess(tools.ffmpeg, [
  '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '64000', fixture,
]);
const token = randomUUID();
const app = await createServer({
  dataDir: path.join(evidenceDir, `service-${Date.now()}`),
  ownerToken: token,
  tools,
});
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: process.env.MW_BROWSER_CHANNEL || 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1528, height: 900 } });
const errors: string[] = [];
const checks: string[] = [];
const screenshots: string[] = [];
page.on('pageerror', error => errors.push(error.message));

async function navigate(name: string) {
  const header = page.locator('.app-header');
  const mobile = page.locator('.mobile-navigation');
  const candidates = name === 'Settings'
    ? header.getByRole('button', { name, exact: true })
    : (await mobile.isVisible() ? mobile : header).getByRole('button', { name, exact: true });
  await candidates.click();
  await page.locator('main').waitFor();
}

async function tool(name:string) { await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name,exact:true}).click(); }

async function noOverflow(label: string) {
  const result = await page.evaluate(() => {
    const width = window.innerWidth;
    const allowed = '.timeline-scroll, .table-scroll, .cut-preview, .region-list, pre';
    return {
      width,
      document: document.documentElement.scrollWidth,
      escaped: Array.from(document.querySelectorAll<HTMLElement>('main *, header *, .mobile-navigation *, dialog[open], dialog[open] *'))
        .filter(element => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && element.checkVisibility() && !element.closest(allowed)
            && (box.left < -1 || box.right > width + 1);
        })
        .map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80) }))
        .slice(0, 12),
    };
  });
  assert.ok(result.document <= result.width + 1, `${label} has horizontal page overflow: ${JSON.stringify(result)}`);
  assert.deepEqual(result.escaped, [], `${label} has escaped content`);
  checks.push(`${label}: no horizontal page overflow or escaped controls`);
}

async function touchTargets(label: string) {
  const undersized = await page.evaluate(() => {
    const selector = '.app-header button, .mobile-navigation button, .editor-tool-rail button, .editor-tool-rail summary, .editor-context-panel button, .editor-context-panel select, .editor-context-panel input:not([type=checkbox]), .cut-transport button, .cut-transport select, .compact-timeline-toolbar button, .compact-timeline-toolbar input:not([type=checkbox]), .timeline-more summary, .trim-handle, .selection-handle, .cut-precision summary, .cut-precision button, .cut-precision select, .cut-precision input:not([type=checkbox]), .check, main:not(.editor-main) button, main:not(.editor-main) select, main:not(.editor-main) input:not([type=checkbox]), main:not(.editor-main) summary, main:not(.editor-main) .actions > a, .export-dialog button, .export-dialog select, .export-dialog input:not([type=checkbox]), .rendered-preview-dialog button, .rendered-preview-dialog select, .rendered-preview-dialog input, .rendered-preview-dialog .actions > a';
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && element.checkVisibility()
          && (box.width < 43.9 || box.height < 43.9);
      })
      .map(element => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, className: element.className, name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 50), width: box.width, height: box.height };
      });
  });
  assert.deepEqual(undersized, [], `${label}: controls are below the 44px touch minimum`);
  checks.push(`${label}: visible navigation, form and panel targets meet 44px minimum`);
}

async function textContrast(label: string) {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  const failures = await page.evaluate(String.raw`(() => {
    const rgb = (value) => {
      const parts = value.match(/[\d.]+/g)?.map(Number) || [];
      return parts.length >= 3 ? parts.slice(0, 3) : [0, 0, 0];
    };
    const luminance = (values) => {
      const channels = values.map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    };
    const background = (element) => {
      let current = element;
      while (current) {
        const value = getComputedStyle(current).backgroundColor;
        if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return rgb(value);
        current = current.parentElement;
      }
      return [0, 0, 0];
    };
    return Array.from(document.querySelectorAll('main *, .app-header *, .mobile-navigation *'))
      .filter(element => element.checkVisibility()
        && !element.closest('.canvas-text-layer, .cut-preview, button:disabled, input:disabled, select:disabled')
        && Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
      .flatMap(element => {
        const style = getComputedStyle(element);
        const foreground = luminance(rgb(style.color));
        const behind = luminance(background(element));
        const contrast = (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && parseInt(style.fontWeight) >= 700);
        return contrast + .05 >= (large ? 3 : 4.5) ? [] : [{ text: element.textContent?.trim().slice(0, 65), className: element.className, color: style.color, contrast: Number(contrast.toFixed(2)) }];
      }).slice(0, 12);
  })()`);
  assert.deepEqual(failures, [], `${label}: text contrast falls below WCAG AA`);
  checks.push(`${label}: visible text pairings meet AA contrast`);
}

async function capture(name: string) {
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(evidenceDir, filename) });
  screenshots.push(filename);
}

async function captureInspector(name: string) {
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await page.evaluate(() => {
    const panel = document.querySelector('.editor-context-panel');
    if (panel) window.scrollTo(0, window.scrollY + panel.getBoundingClientRect().top - 12);
  });
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(evidenceDir, filename) });
  screenshots.push(filename);
}

async function mobileToolAccess(label: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const nav = await page.locator('.mobile-navigation').boundingBox();
  const rail = page.getByRole('navigation', { name: 'Editing tools' });
  assert(nav);
  const controls = [rail.getByRole('button', { name: 'Cut', exact: true }),
    rail.getByRole('button', { name: 'Text', exact: true }),
    rail.getByRole('button', { name: 'Audio', exact: true }),
    rail.getByRole('button', { name: 'Transform', exact: true })];
  for (const control of controls) {
    const box = await control.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= nav.y + 1,
      `${label}: labeled editing tool must fit above bottom navigation`);
    assert.equal(await control.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === element || !!hit && element.contains(hit);
    }), true, `${label}: editing tool is hit-testable in the initial viewport`);
  }
  checks.push(`${label}: Text, Audio, Transform and Cut stay visible and hit-testable in the initial viewport`);

  for (const [name, heading] of [['Cut', 'Trim section 1'], ['Text', 'Text'], ['Audio', 'Audio'], ['Transform', 'Transform']]) {
    await tool(name);
    await page.waitForFunction(transform => {
      const heading = document.querySelector(transform ? '.viewport-transform-controls' : '.context-panel-heading');
      const rail = document.querySelector('.editor-tool-rail');
      if (!heading || !rail) return false;
      const box = heading.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= rail.getBoundingClientRect().top;
    }, name === 'Transform');
    assert.equal(await page.locator('.context-panel-heading > span').innerText(), heading);
  }
  assert.equal(await rail.getByRole('button').count(),5);
  assert.equal(await rail.getByRole('button',{name:'Media',exact:true}).count(),0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() => {
    const preview = document.querySelector('.cut-preview')?.getBoundingClientRect();
    const rail = document.querySelector('.editor-tool-rail')?.getBoundingClientRect();
    return !!preview && !!rail && preview.top >= 0 && preview.top < rail.top;
  });
  assert.equal(await page.locator('.editor-context-panel').isVisible(), false);
  checks.push(`${label}: tool taps reveal panel headings, the rail contains only Text, Audio, Transform and Cut, and Done returns to the preview`);
  await tool('Cut');
  await page.waitForFunction(() => {
    const box = document.querySelector('.context-panel-heading')?.getBoundingClientRect();
    const rail = document.querySelector('.editor-tool-rail')?.getBoundingClientRect();
    return !!box && !!rail && box.top >= 0 && box.bottom <= rail.top;
  });
}

async function field(label: string, value: string) {
  const control = page.getByLabel(label, { exact: true });
  await control.fill(value);
  await control.press('Enter');
}

async function waitValue(label: string, value: string) {
  await page.waitForFunction(({ label, value }) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(label)}"]`);
    return input?.value === value;
  }, { label, value });
}

async function pollJob(type: string, excluded: string[] = []) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const jobs = await page.evaluate(async () => (await fetch('/api/v1/jobs')).json());
    const result = jobs.find((job: any) => job.request.type === type && !excluded.includes(job.id));
    if (result && ['completed', 'failed', 'cancelled'].includes(result.state)) return result;
    await page.waitForTimeout(300);
  }
  throw new Error(`No terminal ${type} job within 36 seconds`);
}

try {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(origin);
  await page.getByLabel('Access token', { exact: true }).waitFor();
  await noOverflow('Connection screen 320px');
  await capture('after-connect-mobile');
  await page.setViewportSize({ width: 1528, height: 900 });
  await page.getByLabel('Access token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.app-header').waitFor();
  await navigate('Library');
  await page.getByRole('heading', { name: 'Library', exact: true }).waitFor();
  await capture('after-library-empty-desktop');
  await navigate('Library');
  await noOverflow('Empty jobs desktop');
  await navigate('Editor');
  await page.getByRole('heading', { name: 'Choose a video to edit' }).waitFor();
  checks.push('Empty library, jobs and editor expose useful visible states');

  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByLabel('Local media', { exact: true }).setInputFiles({ name: 'Sample video.mp4', mimeType: 'video/mp4', buffer: await readFile(fixture) });
  await page.getByRole('heading',{name:'Library',exact:true}).waitFor();
  await page.locator('.media-card').filter({hasText:'Sample video.mp4'}).getByRole('button',{name:'Edit source',exact:true}).click();
  await page.locator('.cut-workspace').waitFor({ timeout: 45000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    const thumbs = Array.from(document.querySelectorAll<HTMLImageElement>('img[alt^="Source thumbnail"]'));
    return video && video.readyState >= 2 && thumbs.length === 4 && thumbs.every(image => image.complete && image.naturalWidth > 0);
  });
  checks.push('Generated local MP4 imports into the real editor and all source thumbnails decode');
  await tool('Cut');
  await capture('checkpoint-editor-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('checkpoint-editor-mobile');
  await page.setViewportSize({ width: 1528, height: 900 });
  console.log(`Visual checkpoint saved to ${evidenceDir}`);
  await textContrast('Desktop editor');
  await field('Region 1 in timecode', '0.5');
  await field('Region 1 out timecode', '3');
  assert.equal(await page.getByLabel('Region 1 in timecode', { exact: true }).inputValue(), '00:00:00.500');
  assert.equal(await page.getByLabel('Region 1 out timecode', { exact: true }).inputValue(), '00:00:03.000');
  await page.getByLabel('Region 1 in timecode', { exact: true }).focus();
  await page.keyboard.press('o');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('Region 1 out timecode', { exact: true }).inputValue(), '00:00:03.000');
  checks.push('Typed trim timecodes commit actual bounds; typing in a field does not invoke editing shortcuts');

  await page.getByRole('button', { name: 'Play source region', exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && !video.paused && video.currentTime >= .5;
  });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && video.paused && Math.abs(video.currentTime - 3) < .003;
  });
  checks.push('Real source-region playback starts and stops at the edited boundaries');

  for (const viewport of [{ width: 1528, height: 900 }, { width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 900, height: 600 }, { width: 851, height: 600 }]) {
    await page.setViewportSize(viewport);
    await noOverflow(`Editor ${viewport.width}x${viewport.height}`);
    const rail = await page.getByRole('navigation', { name: 'Editing tools' }).boundingBox();
    const more = await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Cut',exact:true}).boundingBox();
    assert(rail && more && more.y + more.height <= rail.y + rail.height + 1, 'More tools fits inside the editor rail');
    await capture(`after-editor-${viewport.width}x${viewport.height}`);
  }

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await tool('Cut');
    await noOverflow(`Editor ${viewport.width}x${viewport.height}`);
    await touchTargets(`Editor ${viewport.width}x${viewport.height}`);
    await mobileToolAccess(`Editor ${viewport.width}x${viewport.height}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    const positions = await page.evaluate(() => {
      return {
        player: document.querySelector('.cut-player')?.getBoundingClientRect().top,
        timeline: document.querySelector('.context-timeline')?.getBoundingClientRect().top,
        panel: document.querySelector('.editor-context-panel')?.getBoundingClientRect().top,
      };
    });
    assert.ok(positions.player! < positions.panel! && positions.panel! < positions.timeline!, 'Mobile editor keeps the inspector beside the workflow: preview, inspector, timeline, with persistent tools');
    if (viewport.width === 844) {
      const frame = await page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!;
        const box = video.getBoundingClientRect();
        const rail = document.querySelector('.editor-tool-rail')!.getBoundingClientRect();
        const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
        const height = video.videoHeight * scale;
        const width = video.videoWidth * scale;
        return { fit: getComputedStyle(video).objectFit, top: box.top + (box.height - height) / 2,
          bottom: box.top + (box.height + height) / 2, left: box.left + (box.width - width) / 2,
          right: box.left + (box.width + width) / 2, railTop: rail.top, viewportWidth: innerWidth };
      });
      assert.equal(frame.fit, 'fill');
      assert.ok(frame.top >= 0 && frame.bottom <= frame.railTop && frame.left >= 0 && frame.right <= frame.viewportWidth,
        `Landscape shows the whole original frame above editing tools: ${JSON.stringify(frame)}`);
      checks.push('Short landscape viewport contains the whole original frame above persistent tools and navigation');
    }
    await capture(`after-editor-${viewport.width}x${viewport.height}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.context-timeline').scrollIntoViewIfNeeded();
  const startHandle = page.getByRole('slider', { name: 'Region 1 start trim handle', exact: true });
  const handleBox = await startHandle.boundingBox();
  assert.ok(handleBox && handleBox.width >= 44 && handleBox.height >= 44, 'Mobile trim handle has a 44px hit area');
  await startHandle.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="Region 1 in timecode"]')?.value === '00:00:00.510');
  assert.equal(await page.getByLabel('Region 1 in timecode', { exact: true }).inputValue(), '00:00:00.510');
  const draggedHandle = await startHandle.boundingBox();
  assert(draggedHandle);
  await page.mouse.move(draggedHandle.x + draggedHandle.width / 2, draggedHandle.y + draggedHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(draggedHandle.x + draggedHandle.width / 2 + 15, draggedHandle.y + draggedHandle.height / 2, { steps: 6 });
  await page.mouse.up();
  assert.ok(Number(await startHandle.getAttribute('aria-valuenow')) > .51, 'Dragging the trim handle updates actual source-time bounds');
  checks.push('Mobile trim handles expose 44px hit areas and both keyboard and pointer edits update the actual recipe');
  await tool('Text');
  await page.getByRole('checkbox',{name:'Caption above video',exact:true}).check();
  await page.getByLabel('Caption text',{exact:true}).fill('A local preview');
  await page.getByLabel('Caption text size',{exact:true}).fill('20');
  await page.getByLabel('Caption padding',{exact:true}).fill('12');
  assert.equal(await page.getByLabel('Caption text',{exact:true}).inputValue(),'A local preview');
  assert.equal(await page.getByLabel('Volume multiplier',{exact:true}).inputValue(),'1');
  assert.equal(await page.locator('.viewport-caption').innerText(),'A local preview');
  checks.push('Caption appears above the picture, updates live and leaves audio unchanged');
  await noOverflow('Mobile text inspector');
  await touchTargets('Mobile text inspector');
  await capture('after-editor-text-mobile');
  await captureInspector('after-editor-text-inspector-mobile');
  await page.setViewportSize({ width: 1528, height: 900 });
  await page.getByLabel('Export maximum file size', { exact: true }).selectOption('20000000');
  await page.getByLabel('Export file type', { exact: true }).selectOption('mp4');
  await page.getByLabel('Export resolution', { exact: true }).selectOption('original');
  await capture('after-editor-text-desktop');
  assert.equal(await page.locator('.cut-precision').evaluate(element => (element as HTMLDetailsElement).open), false);
  await page.locator('.app-header').getByRole('button', { name: 'Render edited preview', exact: true }).click();
  const renderedDialog = page.getByRole('dialog', { name: 'Export preview', exact: true });
  await renderedDialog.waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('video[aria-label="Rendered export preview"]');
    return video && video.readyState >= 2 && video.currentTime > 0;
  }, undefined, { timeout: 60000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('Mobile rendered preview dialog');
  await touchTargets('Mobile rendered preview dialog');
  await capture('after-rendered-preview-mobile');
  await renderedDialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.setViewportSize({ width: 1528, height: 900 });
  checks.push('Direct desktop Render preview works with playback options closed and plays a validated edited file');
  await page.getByLabel('Export file type', { exact: true }).selectOption('mkv');
  await page.setViewportSize({ width: 390, height: 844 });
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible()) {
    await done.click();
    assert.equal(await page.locator('.editor-context-panel').isVisible(), false);
    await tool('Text');
    assert.equal(await page.locator('.editor-context-panel').isVisible(), true);
    checks.push('Done closes the mobile inspector and tapping its tool reopens it');
  }
  await tool('Audio');
  await page.getByLabel('Volume multiplier', { exact: true }).fill('0.5');
  await noOverflow('Mobile audio inspector');
  await touchTargets('Mobile audio inspector');
  await tool('Transform');
  await page.getByRole('checkbox', { name: 'Resize', exact: true }).check();
  await page.getByLabel('Output width', { exact: true }).fill('160');
  await page.getByLabel('Output height', { exact: true }).fill('90');
  await noOverflow('Mobile transform inspector');
  await touchTargets('Mobile transform inspector');
  await capture('after-editor-transform-mobile');
  await tool('Cut');

  const priorJobIds: string[] = await page.evaluate(async () => (await (await fetch('/api/v1/jobs')).json()).map((job: any) => job.id));
  const exportButton = page.locator('.app-header').getByRole('button', { name: /^(Review export|Export[.…]?)$/ });
  await exportButton.click();
  const dialog = page.getByRole('dialog', { name: 'Export media' });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Output goal', { exact: true }).inputValue(), 'size');
  assert.equal(await dialog.getByLabel('Maximum size (MB)', { exact: true }).inputValue(), '20');
  assert.equal(await dialog.getByLabel('Container', { exact: true }).inputValue(), 'mkv');
  checks.push('Desktop export summary updates the reviewed export options without submitting a job');
  const submit = dialog.getByRole('button', { name: 'Export using reviewed plan', exact: true });
  assert.equal(await submit.isDisabled(), true, 'Unreviewed export cannot be submitted');
  await dialog.getByRole('button', { name: /^(Resolve export plan|Review export plan)$/ }).click();
  await dialog.locator('.plan').waitFor({ timeout: 30000 });
  await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const planBox = await dialog.locator('.plan').boundingBox();
  const actionsBox = await dialog.locator('.panel > .actions').boundingBox();
  assert(planBox && actionsBox && planBox.y + planBox.height <= actionsBox.y + 1, 'Reviewed settings appear before the final export actions');
  await noOverflow('Mobile reviewed export');
  await touchTargets('Mobile reviewed export');
  await capture('after-export-plan-mobile');
  await submit.click();
  await dialog.getByRole('button', { name: 'Close export', exact: true }).click();
  const completed = await pollJob('export', priorJobIds);
  assert.equal(completed.state, 'completed', completed.error);
  assert.deepEqual(completed.request.recipe.resize, { width: 160, height: 90 });
  assert.equal(completed.request.recipe.audio.volume, .5);
  assert.equal(completed.request.options.container, 'mkv');
  assert.equal(completed.request.options.maxBytes, 20_000_000);
  const output = await page.request.get(`${origin}/api/v1/artifacts/${completed.artifactId}/content`);
  assert.equal(output.status(), 200);
  assert.ok((await output.body()).length > 1000);
  checks.push('Mobile export requires a reviewed plan and produces a real validated output');

  const bytes = await readFile(fixture);
  const longName = 'Morning coastline walk with family 2026 September original camera recording and a very long descriptive filename.mp4';
  const imported = await page.request.post(`${origin}/api/v1/uploads`, { headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(longName), origin }, data: bytes });
  assert.equal(imported.status(), 200);
  await navigate('Library');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('heading', { name: longName, exact: true }).waitFor();

  for (const viewport of [{ width: 1528, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await navigate('Library');
    await noOverflow(`Library ${viewport.width}px with long filenames`);
    await textContrast(`Library ${viewport.width}px`);
    if (viewport.width <= 850) await touchTargets(`Library ${viewport.width}px`);
    await capture(`after-library-${viewport.width}`);
    await navigate('Library');
    await noOverflow(`Jobs ${viewport.width}px`);
    await textContrast(`Jobs ${viewport.width}px`);
    if (viewport.width <= 850) await touchTargets(`Jobs ${viewport.width}px`);
    await capture(`after-jobs-${viewport.width}`);
    await navigate('Settings');
    for (const tab of ['General', 'Presets', 'Integrations', 'Administration']) {
      await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: tab, exact: true }).click();
      await noOverflow(`Settings ${tab} ${viewport.width}px`);
      await textContrast(`Settings ${tab} ${viewport.width}px`);
      if (viewport.width <= 850) await touchTargets(`Settings ${tab} ${viewport.width}px`);
      await capture(`after-settings-${tab.toLowerCase()}-${viewport.width}`);
    }
    if (viewport.width === 1528) {
      await page.locator('.app-header').getByRole('button', { name: 'Import', exact: true }).click();
      await capture('after-import-desktop');
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app-header').getByRole('button', { name: 'Import', exact: true }).click();
  await noOverflow('Mobile import and URL download');
  await touchTargets('Mobile import and URL download');
  await capture('after-import-mobile');
  await page.getByRole('button',{name:'From a link',exact:true}).click();
  await page.getByLabel('Video or audio links', { exact: true }).fill('not a media URL');
  await page.getByRole('button', { name: 'Inspect available media', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await noOverflow('Mobile input error state');
  checks.push('Invalid URL shows a visible error without starting an external content download');

  await page.setViewportSize({ width: 1528, height: 900 });
  await navigate('Library');
  const search = page.getByLabel('Search media', { exact: true });
  await search.focus();
  const focus = await search.evaluate(element => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
  });
  assert.ok(focus.style !== 'none' && focus.width >= 2, `Keyboard focus must remain visible: ${JSON.stringify(focus)}`);
  await search.fill('no-matching-file-exists');
  assert.equal(await page.locator('.media-card').count(), 0);
  await capture('after-library-search-empty-desktop');
  checks.push('Keyboard focus is visible and searching a missing filename shows an empty result');

  await navigate('Settings');
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Color theme', { exact: true }).selectOption('light');
  await textContrast('Light settings desktop');
  await navigate('Library');
  await textContrast('Light library desktop');
  await capture('after-library-light-desktop');
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('.cut-workspace').waitFor();
  await noOverflow('Restored editor with light preference');
  await textContrast('Restored editor with light preference');
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow('Light preference editor 320px');
  await touchTargets('Light preference editor 320px');
  await capture('after-editor-light-mobile');
  await navigate('Settings');
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Color theme', { exact: true }).selectOption('dark');
  checks.push('Light preference restores after reload and keeps readable contrast and mobile controls');
  assert.deepEqual(errors, [], 'No unhandled browser errors');
  await writeFile(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ testedAt: new Date().toISOString(), origin, checks, errors, screenshots, artifactId: completed.artifactId }, null, 2));
  console.log(JSON.stringify({ checks, screenshots, errors }));
} catch (error) {
  await page.screenshot({ path: path.join(evidenceDir, 'failure.png'), fullPage: true });
  await writeFile(path.join(evidenceDir, 'failure.json'), JSON.stringify({ error: String(error), checks, errors, body: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally {
  await browser.close();
  await app.close();
}
