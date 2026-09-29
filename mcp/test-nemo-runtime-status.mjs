import assert from 'node:assert/strict';
import test from 'node:test';

import { SillyTavernClient } from './sillytavern-server.mjs';

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: {
      getSetCookie() { return []; },
      get(name) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('Nemo runtime report is read through SillyTavern user-files route', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/csrf-token')) {
      return response({ token: 'csrf' });
    }
    assert.equal(
      String(url),
      'https://st.example.test/user/files/nemo-runtime-report.json',
    );
    return response({
      ok: true,
      preset: 'Nemo Engine 11.5.2 - Ready RU RP',
      promptCount: 458,
      regexCount: 97,
      recipe: { applicable: false, active: false, validated: false },
      vex: { applicable: false, active: false, validated: false },
      cold: { applicable: true, active: true, validated: true, count: 445 },
      sidecars: { recipe: 0, vex: 0, cold: 1 },
      rendering: { stage: '5B.3/5', enabled: true, clientRuntime: 'NemoPresetExt' },
    });
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const report = await client.getNemoRuntimeStatus();
  assert.equal(report.ok, true);
  assert.equal(report.cold.count, 445);
  assert.equal(calls.length, 2);
});
