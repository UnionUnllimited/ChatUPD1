// Import cards Линза adds itself from a JSON or CSV file into the configured database:
//   npm run import -- seed/catalog/lens-2026-10-31.json [--dry-run]
// On the server (Docker):  sudo docker compose exec app npm run import -- seed/catalog/<file>
// Rows already in the catalog (same bot) are skipped and reported; the catalog picks up the rest within a minute.
import { readFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { importServices, copyLogos } from '../server/lib/importer.js';
import { CARD_PARTS } from '../public/js/dict.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run import -- <file.json|file.csv> [--dry-run]');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const db = openDb(config.dbPath);
const r = importServices(db, { id: null }, readFileSync(file, 'utf8'), { dryRun, uploadsDir: config.uploadsDir });
const unknown = (m) => (m?.length ? ` — уточняется: ${m.map((k) => CARD_PARTS[k]).join(', ')}` : '');
console.log(`${dryRun ? 'Проверка' : 'Импорт'}: ${dryRun ? r.ok.length : r.created.length} из ${r.total}`);
for (const x of dryRun ? r.ok : r.created) console.log(`  ✓ ${x.name}${unknown(x.missing)}`);
for (const e of r.errors) console.log(`  ✕ строка ${e.line} · ${e.name}: ${e.error}`);
if (!dryRun && r.created.length) {
  const copied = await copyLogos(db, r.created, { uploadsDir: config.uploadsDir });
  console.log(`Логотипы: скопировано ${copied} из ${r.created.length}${copied < r.created.length ? ' (остальные — ссылкой на Telegram)' : ''}`);
}
db.close();
