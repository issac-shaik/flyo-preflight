// Writes the sample e-ticket PDFs and traveller documents to samples-out/ (for drag-and-drop or WhatsApp demos).
// Dates are relative to today, so regenerate them on the day of the demo.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTicketSamples, ticketSample, listDocSamples, docSampleSvg } from '../src/app/samples/samples.mjs';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples-out');
mkdirSync(out, { recursive: true });
for (const { id } of listTicketSamples()) {
  const s = ticketSample(id);
  writeFileSync(path.join(out, s.filename), s.pdf);
  writeFileSync(path.join(out, `${id}-eticket.txt`), s.text);
}
for (const d of listDocSamples()) writeFileSync(path.join(out, `${d.id}.svg`), docSampleSvg(d.id));
console.log(`Wrote samples to ${out}`);
