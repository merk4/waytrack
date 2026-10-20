import { bearing, measure, pointAt } from '../geo/distance.ts';
import type { LngLat } from '../geo/types.ts';
import { segmentValues } from './spans.ts';
import type { Instruction, Span, TurnKind } from './types.ts';

/** Signed heading change in degrees, (-180, 180]; positive = right. */
function signedTurn(inDeg: number, outDeg: number): number {
  const d = (((outDeg - inDeg) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

function turnKind(delta: number): TurnKind {
  const a = Math.abs(delta);
  if (a >= 155) return 'u_turn';
  if (a < 20) return 'continue';
  const side = delta > 0 ? 'right' : 'left';
  if (a < 45) return side === 'right' ? 'slight_right' : 'slight_left';
  if (a < 135) return side;
  return side === 'right' ? 'sharp_right' : 'sharp_left';
}

const PHRASE: Record<TurnKind, string> = {
  continue: 'Continue',
  slight_left: 'Bear left',
  left: 'Turn left',
  sharp_left: 'Turn sharp left',
  slight_right: 'Bear right',
  right: 'Turn right',
  sharp_right: 'Turn sharp right',
  keep_left: 'Keep left',
  keep_right: 'Keep right',
  u_turn: 'Turn around',
  roundabout: 'Take the roundabout',
  via: 'Pass waypoint',
  arrive: 'Arrive at the finish',
  other: 'Continue',
};

const onto = (name: string) => (name ? `onto ${name}` : 'onto the path');

/**
 * Street-by-street steps derived from geometry and street names alone, so they stay
 * correct for composed routes (laps, out-and-backs, detours) that no single provider
 * response describes. English; turns are measured over ±`armM`.
 */
export function deriveInstructions(geometry: readonly LngLat[], streetNames: readonly Span<string>[] | undefined, armM = 15, minStepM = 15): Instruction[] {
  const line = measure(geometry);
  const n = geometry.length - 1;
  if (n < 1) return [];
  const names = segmentValues<string>(n, streetNames, '');
  const turnAt = (k: number) => {
    const d = line.cumulative[k]!;
    return signedTurn(bearing(pointAt(line, d - armM), geometry[k]!), bearing(geometry[k]!, pointAt(line, d + armM)));
  };

  // Break points: street name changes, or a U-turn on the same street.
  const breaks: number[] = [0];
  for (let k = 1; k < n; k++) {
    const sameName = names[k] === names[k - 1];
    if (!sameName || Math.abs(turnAt(k)) >= 155) breaks.push(k);
  }

  const steps: Instruction[] = [];
  for (let b = 0; b < breaks.length; b++) {
    const from = breaks[b]!;
    const to = breaks[b + 1] ?? n;
    const len = line.cumulative[to]! - line.cumulative[from]!;
    const name = names[from]!;
    if (b === 0) {
      steps.push({ turn: 'continue', text: `Head out on ${name || 'the path'}`, streetName: name, distanceM: len, from, to });
      continue;
    }
    const turn = turnKind(turnAt(from));
    const prev = steps[steps.length - 1]!;
    // Fold tiny name changes (crossings, short links) into the previous step unless it's a U-turn.
    if (len < minStepM && turn !== 'u_turn') {
      steps[steps.length - 1] = { ...prev, distanceM: prev.distanceM + len, to };
      continue;
    }
    if (turn === 'continue' && name === prev.streetName) {
      steps[steps.length - 1] = { ...prev, distanceM: prev.distanceM + len, to };
      continue;
    }
    const text = turn === 'u_turn' ? `Turn around${name ? ` on ${name}` : ''}` : `${PHRASE[turn]} ${onto(name)}`;
    steps.push({ turn, text, streetName: name, distanceM: len, from, to });
  }
  steps.push({ turn: 'arrive', text: PHRASE.arrive, streetName: '', distanceM: 0, from: n, to: n });
  return steps;
}
