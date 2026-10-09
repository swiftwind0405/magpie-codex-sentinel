import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analyzeFingerprint, buildFingerprintProbes } from '../src/fingerprint.mjs';

const vendor = new URL('../vendor/modeltrace/', import.meta.url);
const jsonFile = (file) => JSON.parse(readFileSync(new URL(file, vendor), 'utf8'));
const hash = (file) => createHash('sha256').update(readFileSync(new URL(file, vendor))).digest('hex');

// Synthetic arrays test parsing and deterministic scoring, never model accuracy.
function sample(expectedCount = 301, offset = 0) {
  return {
    expectedCount,
    text: JSON.stringify(Array.from({ length: expectedCount }, (_, index) => (index * 67 + offset * 19) % 355 + 1)),
  };
}

test('vendored sources preserve the complete pinned upstream artifacts and license', () => {
  const provenance = jsonFile('provenance.json');
  assert.equal(provenance.commit, 'd4131b30243dfa05e70180b5eedde742103f1d73');
  assert.equal(hash('unified_bank.json'), 'e514c76928ea38d23bc0f14d3935f23c97b1efb6d96b18a19bdc88ad2d830536');
  assert.equal(hash('fingerprint-core.js'), '83fa5bd611e18f8339122582335123c8ea168ed242298bb31f4e363abeeb6e4a');
  for (const [file, metadata] of Object.entries(provenance.files)) assert.equal(hash(file), metadata.sha256, file);
  assert.equal(hash('reference-probes.json'), provenance.promptProtocol.derivedFileSha256);
  const bank = jsonFile('unified_bank.json');
  assert.equal(bank.models.length, 17);
  assert.equal(bank.models.reduce((sum, model) => sum + model.response_count, 0), 612);
  assert.match(readFileSync(new URL('LICENSE', vendor), 'utf8'), /Copyright \(c\) 2026 xqy2006/);
});

test('seed only permutes exact environment-06 reference prompts', () => {
  const seed = '__do_not_send_this_seed_to_the_model__';
  const probes = buildFingerprintProbes({ seed });
  assert.deepEqual(probes, buildFingerprintProbes({ seed }));
  assert.equal(new Set(probes.map((probe) => probe.id)).size, 3);
  const references = jsonFile('reference-probes.json');
  for (const probe of probes) {
    const original = references.find((reference) => reference.challenge_id === probe.referenceChallengeId);
    assert.equal(probe.prompt, original.prompt);
    assert.equal(probe.expectedCount, original.expected_count);
    assert.equal(probe.family, 'fingerprint');
    assert.ok(!probe.prompt.includes(seed));
    assert.match(probe.prompt, /Return one compact JSON array/);
  }
  assert.equal(buildFingerprintProbes({ samples: 1 }).length, 1);
  assert.throws(() => buildFingerprintProbes({ samples: 4 }), RangeError);
});

test('valid literal arrays yield stable finite closed-set report data', () => {
  const samples = [sample(301), sample(319, 1), sample(327, 2)];
  const result = analyzeFingerprint(samples);
  assert.deepEqual(result, analyzeFingerprint(samples));
  assert.equal(result.status, 'reported');
  assert.equal(result.acceptedSamples, 3);
  assert.equal(result.rejectedSamples, 0);
  assert.equal(result.candidates.length, 17);
  assert.ok(result.score > 0 && result.score <= 1);
  assert.ok(result.margin >= 0 && result.margin <= 1);
  assert.ok(Math.abs(result.candidates.reduce((sum, item) => sum + item.weight, 0) - 1) < 1e-12);
  assert.equal(result.scoreKind, 'closed_set_similarity_weight');
  assert.equal(result.source.magpieTransportCalibrated, false);
  assert.equal(result.upstreamReferenceCalibration.applicableToMagpie, false);
  assert.ok(result.limitations.some((message) => message.includes('不是降智分数')));
  const fenced = analyzeFingerprint([{ ...samples[0], text: '```json\n' + samples[0].text + '\n```' }]);
  assert.equal(fenced.acceptedSamples, 1);
});

test('invalid output is rejected before permissive fingerprint extraction', () => {
  const valid = sample();
  const invalid = [
    { ...valid, text: 'Here are the numbers: ' + valid.text },
    { ...valid, text: valid.text + '\n' + valid.text },
    { ...valid, text: valid.text.replace(/^\[1,/, '[1e2,') },
    { ...valid, text: valid.text.replace(/^\[1,/, '[356,') },
    { ...valid, text: '[1,2,3]' },
    { ...valid, text: valid.text.slice(0, -1) },
    { ...valid, text: JSON.stringify(Array(378).fill(1)) },
    { text: valid.text },
  ];
  for (const input of invalid) {
    const result = analyzeFingerprint([input]);
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.acceptedSamples, 0);
    assert.equal(result.rejectedSamples, 1);
    assert.equal(result.prediction, null);
    assert.equal(result.score, null);
    assert.equal(result.diagnostics[0].accepted, false);
  }
});

test('absent and partial samples are explicit and never become capability verdicts', () => {
  const empty = analyzeFingerprint();
  assert.equal(empty.status, 'inconclusive');
  assert.equal(empty.reason, 'no_samples');
  assert.equal(empty.score, null);
  const partial = analyzeFingerprint([sample(), { expectedCount: 319, text: '' }]);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.acceptedSamples, 1);
  assert.equal(partial.rejectedSamples, 1);
  assert.equal(partial.upstreamReferenceCalibration.queryCount, 1);
  assert.deepEqual(partial.diagnostics.map((item) => item.accepted), [true, false]);
  assert.throws(() => analyzeFingerprint(Array(4).fill(sample())), RangeError);
});
