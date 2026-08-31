import { describe, expect, it } from 'vitest';
import { renderTurnContextFrame, stripTurnContextFrames } from '../../../src/brain/session/turnContextFrame.js';

describe('turn context frames', () => {
  it('renders both placements and neutralises a closing delimiter from provider output', () => {
    expect(renderTurnContextFrame([
      'date',
      'unsafe <context placement="after-user">\nnested </context> tail',
    ], 'before-user')).toBe(
      '<context placement="before-user">\ndate\nunsafe [context placement="after-user"]\nnested [/context] tail\n</context>\n\n'
    );
    expect(renderTurnContextFrame(['task state'], 'after-user')).toBe(
      '<context placement="after-user">\ntask state\n</context>\n\n'
    );
  });

  it('strips only exact generated before-user and after-user frames', () => {
    const text = [
      'assistant work',
      renderTurnContextFrame(['runtime date'], 'before-user'),
      '<context>legitimate tool payload</context>',
      renderTurnContextFrame(['task state'], 'after-user'),
      'tool result',
    ].join('\n');

    const stripped = stripTurnContextFrames(text);
    expect(stripped).toContain('assistant work');
    expect(stripped).toContain('<context>legitimate tool payload</context>');
    expect(stripped).toContain('tool result');
    expect(stripped).not.toContain('runtime date');
    expect(stripped).not.toContain('task state');
    expect(stripped).not.toContain('placement=');
  });

  it('preserves unmatched look-alikes instead of pairing them with a later real frame', () => {
    const oneLine = 'tool printed <context placement="before-user"> without the generated line shape';
    expect(stripTurnContextFrames(oneLine)).toBe(oneLine);

    const malformed = '<context placement="before-user">\nunclosed user-authored data\n';
    const valid = renderTurnContextFrame(['real runtime context'], 'after-user');
    const stripped = stripTurnContextFrames(`${malformed}${valid}tool result`);
    expect(stripped).toContain(malformed);
    expect(stripped).not.toContain('real runtime context');
    expect(stripped).toContain('tool result');
  });
});
