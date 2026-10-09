import assert from 'node:assert/strict';
import test from 'node:test';
import { SUITE_VERSION, buildSuite, candyOracle, gradeCase } from '../src/suite.mjs';

// Independent reference: enumerate actual six-flavor draw counts, mark every
// quota that admits a losing draw, then search all quotas. No rectangle formula.
function exhaustiveCandy(round, star) {
  const [a, b, c] = round;
  const [d, e, f] = star;
  const losing = new Set();
  for (let appleRound = 0; appleRound <= a; appleRound += 1) {
    for (let peachRound = 0; peachRound <= b; peachRound += 1) {
      for (let melonRound = 0; melonRound <= c; melonRound += 1) {
        for (let appleStar = 0; appleStar <= d; appleStar += 1) {
          for (let peachStar = 0; peachStar <= e; peachStar += 1) {
            for (let melonStar = 0; melonStar <= f; melonStar += 1) {
              if (!(appleRound > 0 && peachStar > 0) && !(peachRound > 0 && appleStar > 0)) {
                losing.add(`${appleRound + peachRound + melonRound},${appleStar + peachStar + melonStar}`);
              }
            }
          }
        }
      }
    }
  }
  let minimum = null;
  let plans = [];
  for (let r = 0; r <= a + b + c; r += 1) {
    for (let s = 0; s <= d + e + f; s += 1) {
      if (losing.has(`${r},${s}`)) continue;
      if (minimum === null || r + s < minimum) {
        minimum = r + s;
        plans = [{ round: r, star: s }];
      } else if (r + s === minimum) plans.push({ round: r, star: s });
    }
  }
  return { minimum, plans };
}

test('candy oracle agrees with independent exhaustive draws for all 729 small inventories', () => {
  for (let encoded = 0; encoded < 3 ** 6; encoded += 1) {
    let value = encoded;
    const inventory = Array.from({ length: 6 }, () => {
      const digit = value % 3;
      value = Math.floor(value / 3);
      return digit;
    });
    const round = inventory.slice(0, 3);
    const star = inventory.slice(3);
    assert.deepEqual(candyOracle(round, star), exhaustiveCandy(round, star), JSON.stringify(inventory));
  }
});

test('original candy quantities have minimum 21 and the fixed 9-round/12-star plan', () => {
  const expected = { minimum: 21, plans: [{ round: 9, star: 12 }] };
  assert.deepEqual(exhaustiveCandy([7, 9, 8], [7, 6, 4]), expected);
  assert.deepEqual(candyOracle([7, 9, 8], [7, 6, 4]), expected);
});

test('candy oracle handles impossible instances and validates inventory', () => {
  assert.deepEqual(candyOracle([0, 0, 2], [2, 2, 1]), { minimum: null, plans: [] });
  assert.deepEqual(candyOracle([2, 0, 1], [2, 0, 1]), { minimum: null, plans: [] });
  assert.throws(() => candyOracle([1, -1, 2], [1, 2, 3]), TypeError);
  assert.throws(() => candyOracle([1, 2.5, 2], [1, 2, 3]), TypeError);
  assert.throws(() => candyOracle([1, 2], [1, 2, 3]), TypeError);
  assert.throws(() => candyOracle([Number.MAX_SAFE_INTEGER, 1, 1], [1, 1, 1]), RangeError);
});

test('suite sizes, family balance, stable IDs, seed replay and profile prefix remain stable', () => {
  assert.equal(SUITE_VERSION, 'sentinel-v1');
  const quick = buildSuite({ seed: '稳定种子 42' });
  const standard = buildSuite({ profile: 'standard', seed: '稳定种子 42' });
  assert.equal(quick.length, 6);
  assert.equal(standard.length, 18);
  assert.deepEqual(quick, standard.slice(0, 6));
  assert.deepEqual(standard, buildSuite({ profile: 'standard', seed: '稳定种子 42' }));
  assert.notDeepEqual(quick, buildSuite({ seed: '另一种子 42' }));
  assert.equal(new Set(standard.map(({ id }) => id)).size, 18);
  for (const family of ['candy', 'js-trace', 'constraint']) {
    assert.equal(quick.filter((item) => item.family === family).length, 2);
    assert.equal(standard.filter((item) => item.family === family).length, 6);
  }
  assert.deepEqual(buildSuite(), buildSuite());
  assert.throws(() => buildSuite({ profile: 'unknown' }), TypeError);
  assert.throws(() => buildSuite({ seed: 42 }), TypeError);
});

test('each generated expected answer round-trips through the exact answer protocol', () => {
  for (const seed of ['one', 'two', '三']) {
    for (const item of buildSuite({ profile: 'standard', seed })) {
      const result = gradeCase(item, JSON.stringify({ answer: item.expected }));
      assert.equal(result.passed, true, item.id);
      assert.equal(result.formatValid, true, item.id);
    }
  }
});

test('seeded trace fixtures match manually worked aliasing, control-flow and ordering results', () => {
  const traces = buildSuite({ profile: 'standard', seed: 'review-fixture' })
    .filter((item) => item.family === 'js-trace');
  // 1: original [6,12,5], alias +=3, then shift; copied sum is 6+12+5+6.
  // 2: accumulator is 13,3,15,10,13; only 13,10,13 survive the filter.
  // 3: shared nested n is 8*3, independent top-level n is 7 or 7+4.
  // 4: x values are 5,12,7,18,1,8; the signed running sum ends at 29.
  // 5: splice removes [9,5], reverse/shift returns 5; snapshot starts 7+11.
  // 6: selected (value,index) pairs are (3,2),(10,0),(10,1),(11,5).
  assert.deepEqual(traces.map(({ expected }) => expected), [
    [2, 15, 5, 29],
    [13, 3, 36],
    [7, 24, 11, 23, 1],
    [8, 29],
    [7, 5, 1, 5, 9, 18, 3],
    [5, 10, 11, 16],
  ]);
  assert.match(traces[0].prompt, /const a = \[6, 12, 5\]/);
  assert.match(traces[5].prompt, /const values = \[10,10,3,2,2,11\]/);
});

function clueLines(prompt) {
  return prompt.split('\n').filter((line) => /^\d+\. /.test(line))
    .map((line) => line.replace(/^\d+\. /, ''));
}

function orderSatisfies(order, clue) {
  const position = (letter) => order.indexOf(letter) + 1;
  let match = /^([A-E]) 排在 ([A-E]) 前面/.exec(clue);
  if (match) return position(match[1]) < position(match[2]);
  match = /^([A-E]) 与 ([A-E]) 的位置编号之差的绝对值是 (\d+)。$/.exec(clue);
  if (match) return Math.abs(position(match[1]) - position(match[2])) === Number(match[3]);
  match = /^([A-E]) 与 ([A-E]) 的位置编号之和是 (\d+)。$/.exec(clue);
  if (match) return position(match[1]) + position(match[2]) === Number(match[3]);
  throw new Error(`Unknown ordering clue: ${clue}`);
}

function switchSatisfies(bits, clue) {
  const on = (letter) => bits[letter.charCodeAt(0) - 65] === '1';
  let match = /^([A-E]) 与 ([A-E]) 中恰好一个开启。$/.exec(clue);
  if (match) return on(match[1]) !== on(match[2]);
  match = /^([A-E]) 与 ([A-E]) 的开关状态相同。$/.exec(clue);
  if (match) return on(match[1]) === on(match[2]);
  match = /^([A-E]) 与 ([A-E]) 至少一个开启/.exec(clue);
  if (match) return on(match[1]) || on(match[2]);
  match = /^([A-E]) 与 ([A-E]) 不能同时开启。$/.exec(clue);
  if (match) return !on(match[1]) || !on(match[2]);
  match = /^如果 ([A-E]) 开启，则 ([A-E]) 必须开启/.exec(clue);
  if (match) return !on(match[1]) || on(match[2]);
  throw new Error(`Unknown switch clue: ${clue}`);
}

test('rendered constraint prompts, independently enumerated, each have exactly the expected unique solution', () => {
  // Independent enumeration uses base-5 strings, not the production permutation helper.
  const allOrders = [];
  for (let value = 0; value < 5 ** 5; value += 1) {
    const digits = value.toString(5).padStart(5, '0');
    if (new Set(digits).size === 5) {
      allOrders.push([...digits].map((digit) => 'ABCDE'[Number(digit)]).join(''));
    }
  }
  const allSwitches = Array.from({ length: 32 }, (_, value) => value.toString(2).padStart(5, '0'));
  for (const seed of ['review-fixture', 'logic-second', '边界种子']) {
    for (const item of buildSuite({ profile: 'standard', seed }).filter((entry) => entry.family === 'constraint')) {
      const clues = clueLines(item.prompt);
      assert.ok(clues.length >= 4);
      let solutions;
      if (item.prompt.startsWith('A、B、C、D、E 五个人')) {
        solutions = allOrders.filter((order) => clues.every((clue) => orderSatisfies(order, clue)));
      } else {
        const total = Number(/其中恰好 (\d) 个开启/.exec(item.prompt)[1]);
        solutions = allSwitches.filter((bits) => [...bits].filter((bit) => bit === '1').length === total
          && clues.every((clue) => switchSatisfies(bits, clue)));
      }
      assert.deepEqual(solutions, [item.expected], `${seed}: ${item.id}`);
    }
  }
});

test('grading never treats an incidental 21, negation, decimal or numeric string as a correct integer answer', () => {
  const item = { expected: 21 };
  for (const text of ['21', '答案不是21，正确答案29', '21.5', '1e21', '二十一', '{"answer":"21"}', '{"result":21}', '{"answer":29,"explanation":"21 is wrong"}']) {
    assert.equal(gradeCase(item, text).passed, false, text);
  }
  assert.equal(gradeCase(item, '{"answer":21.5}').passed, false);
  assert.equal(gradeCase(item, '{"answer":21.5}').formatValid, true);
  assert.equal(gradeCase(item, '{"answer":"21"}').formatValid, false);
  assert.equal(gradeCase(item, '{"answer":29}').formatValid, true);
  assert.equal(gradeCase(item, '{"answer":21}').passed, true);
  assert.equal(gradeCase(item, '{"answer":21,"extra":"allowed"}').passed, true);
});

test('grading accepts only a whole JSON object or one outer json fence', () => {
  const item = { expected: 21 };
  for (const text of [' \n{"answer":21}\n ', '```json\n{"answer":21}\n```', ' \n```JSON\r\n{"answer":21}\r\n``` \n']) {
    assert.equal(gradeCase(item, text).passed, true, text);
  }
  for (const text of [
    '说明：{"answer":21}',
    '{"answer":21} 说明',
    '{"answer":21}\n{"answer":29}',
    '```javascript\n{"answer":21}\n```',
    '```\n{"answer":21}\n```',
    '```json\n{"answer":21}\n```\n说明',
    '```json\n```json\n{"answer":21}\n```\n```',
    '[{"answer":21}]',
    'null',
    '',
    '{"answer":1e9999}',
    '{"answer":21,}',
  ]) {
    assert.equal(gradeCase(item, text).formatValid, false, text);
  }
});

test('answer arrays and strings retain their exact type, contents and order', () => {
  const array = { expected: [1, 2, 3] };
  assert.equal(gradeCase(array, '{"answer":[1,2,3]}').passed, true);
  for (const text of ['{"answer":[3,2,1]}', '{"answer":[1,2]}', '{"answer":[]}']) {
    const result = gradeCase(array, text);
    assert.equal(result.formatValid, true);
    assert.equal(result.passed, false);
  }
  assert.equal(gradeCase(array, '{"answer":["1",2,3]}').formatValid, false);
  const string = { expected: '00111' };
  assert.equal(gradeCase(string, '{"answer":"00111"}').passed, true);
  assert.equal(gradeCase(string, '{"answer":111}').formatValid, false);
  assert.equal(gradeCase(string, '{"answer":"00111 "}').passed, false);
  assert.equal(gradeCase(string, '{"answer":"00110"}').formatValid, true);
  assert.equal(gradeCase(string, undefined).formatValid, false);
  assert.throws(() => gradeCase({}, '{}'), TypeError);
});
