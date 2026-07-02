#!/usr/bin/env node
/**
 * traffic.mjs — exercise the demo API through the wiretype proxy for demos / E2E.
 *
 * Fires ~40 requests covering every route and enough variety to make the
 * inference engine emit enums, formats, optional/nullable fields, unions
 * (via multi-status), path params, query shapes, and request bodies.
 *
 * Usage:
 *   node traffic.mjs [BASE]
 *   PROXY_URL=http://localhost:5050 node traffic.mjs
 *
 * BASE resolution: argv[2] || process.env.PROXY_URL || http://localhost:5050
 *
 * Exit code: non-zero if any request throws a NETWORK error. Non-2xx HTTP
 * responses (e.g. the intentional 404s) are expected and do NOT fail the run.
 */

const BASE = (process.argv[2] || process.env.PROXY_URL || 'http://localhost:5050').replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let networkErrors = 0;
let count = 0;

async function hit(method, path, body) {
  count += 1;
  const url = `${BASE}${path}`;
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    // Drain the body so keep-alive sockets are freed and the exchange completes.
    await res.text().catch(() => {});
    process.stdout.write(`${method} ${path} → ${res.status}\n`);
  } catch (err) {
    networkErrors += 1;
    process.stderr.write(`${method} ${path} → NETWORK ERROR: ${err && err.message}\n`);
  }
  await sleep(25);
}

async function main() {
  process.stdout.write(`traffic: targeting ${BASE}\n`);

  // --- users list: pages 1..4 with varying limit/role (even + odd pages) ---
  await hit('GET', '/api/users?page=1&limit=4');
  await hit('GET', '/api/users?page=2&limit=4'); // even -> experimental field
  await hit('GET', '/api/users?page=3&limit=2');
  await hit('GET', '/api/users?page=4&limit=2'); // even -> experimental field
  await hit('GET', '/api/users?page=1&limit=3&role=admin');
  await hit('GET', '/api/users?page=2&limit=3&role=editor'); // even
  await hit('GET', '/api/users?page=1&limit=5&role=viewer');
  await hit('GET', '/api/users?page=2&limit=8'); // even, whole set

  // --- individual users across different numeric ids (incl. 404s) ---
  await hit('GET', '/api/users/1');
  await hit('GET', '/api/users/2');
  await hit('GET', '/api/users/3');
  await hit('GET', '/api/users/4');
  await hit('GET', '/api/users/5');
  await hit('GET', '/api/users/6');
  await hit('GET', '/api/users/7');
  await hit('GET', '/api/users/8');
  await hit('GET', '/api/users/999'); // 404
  await hit('GET', '/api/users/0');   // 404

  // --- POST /api/users: 3 payloads, one omitting an optional field ---
  await hit('POST', '/api/users', { name: 'Dennis Ritchie', email: 'dennis@example.com', role: 'admin' });
  await hit('POST', '/api/users', { name: 'Ken Thompson', email: 'ken@example.com', role: 'editor' });
  await hit('POST', '/api/users', { name: 'Bjarne', email: 'bjarne@example.com' }); // omit role

  // --- posts: GET all + 404 + PATCH ---
  await hit('GET', '/api/posts/101');
  await hit('GET', '/api/posts/102');
  await hit('GET', '/api/posts/103');
  await hit('GET', '/api/posts/104');
  await hit('GET', '/api/posts/900'); // 404
  await hit('PATCH', '/api/posts/101', { title: 'Notes on the Analytical Engine (rev 2)' });
  await hit('PATCH', '/api/posts/102', { body: 'Revised abstract.', tags: ['theory', 'turing'] });

  // --- more list variety to push enum/optional sample counts up ---
  await hit('GET', '/api/users?page=1&limit=4&role=admin');
  await hit('GET', '/api/users?page=1&limit=4&role=editor');
  await hit('GET', '/api/users?page=1&limit=4&role=viewer');
  await hit('GET', '/api/users?page=2&limit=4&role=viewer'); // even
  await hit('GET', '/api/users?page=1&limit=2');
  await hit('GET', '/api/users?page=2&limit=6'); // even

  // --- health (non-JSON) ---
  await hit('GET', '/api/health');
  await hit('GET', '/api/health');

  // --- a few more individual hits for good measure ---
  await hit('GET', '/api/users/2');
  await hit('GET', '/api/users/5');
  await hit('GET', '/api/posts/103');

  process.stdout.write(`\ntraffic: ${count} requests fired, ${networkErrors} network error(s)\n`);
  if (networkErrors > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`traffic: fatal ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
