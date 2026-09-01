import assert from 'node:assert/strict';
import test from 'node:test';
import { VIDEO_V2_CLIPS, VIDEO_V2_CUES, VIDEO_V2_TARGET_SECONDS, validateVideoV2Spec } from './spec.mjs';

test('locks the seven-clip 175-second V2 narrative', () => {
  assert.equal(validateVideoV2Spec(), true);
  assert.equal(VIDEO_V2_CLIPS.length, 7);
  assert.equal(VIDEO_V2_CLIPS.at(-1).end, VIDEO_V2_TARGET_SECONDS);
  assert.deepEqual(VIDEO_V2_CLIPS.map((clip) => clip.file), [
    '00-hook.webm',
    '01-evidence-auto.webm',
    '02-multi-turn.webm',
    '03-stale-replan.webm',
    '04-human-handoff.webm',
    '05-quality-regression.webm',
    '06-trace-closing.webm',
  ]);
});

test('keeps subtitles concise and narration separate', () => {
  assert.ok(VIDEO_V2_CUES.length >= 24);
  assert.ok(VIDEO_V2_CUES.every((cue) => cue.narration !== cue.subtitle.replaceAll('\n', '')));
  assert.ok(VIDEO_V2_CUES.reduce((sum, cue) => sum + [...cue.narration].length, 0)
    > VIDEO_V2_CUES.reduce((sum, cue) => sum + [...cue.subtitle.replaceAll('\n', '')].length, 0));
  assert.ok(VIDEO_V2_CUES.every((cue) => cue.subtitle.split('\n').every((line) => [...line].length <= 22)));
});
