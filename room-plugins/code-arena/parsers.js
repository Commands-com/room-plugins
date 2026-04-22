export function parseChallenge(response) {
  const text = String(response || '');
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return {
        title: String(parsed.title || 'Untitled Challenge'),
        description: String(parsed.description || 'No description provided.'),
        difficulty: ['Easy', 'Medium', 'Hard'].includes(parsed.difficulty) ? parsed.difficulty : 'Medium',
        language: String(parsed.language || 'javascript'),
      };
    } catch {
      // Fall through.
    }
  }
  return {
    title: 'Round Challenge',
    description: text.slice(0, 1000),
    difficulty: 'Medium',
    language: 'javascript',
  };
}

export function parseVerdict(response, contestant1, contestant2) {
  const text = String(response || '');
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/) || text.match(/\{[\s\S]*"winner"[\s\S]*\}/);
  let parsed = null;

  if (jsonMatch) {
    try {
      parsed = JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
    } catch {
      // Fall through.
    }
  }

  if (!parsed) {
    const c1Lower = contestant1.displayName.toLowerCase();
    const c2Lower = contestant2.displayName.toLowerCase();
    const lower = text.toLowerCase();
    const c1Win = lower.includes(c1Lower) && lower.includes('winner');
    const c2Win = lower.includes(c2Lower) && lower.includes('winner');
    return {
      winner: c1Win && !c2Win ? contestant1.displayName
        : c2Win && !c1Win ? contestant2.displayName : 'draw',
      contestant1Score: 50,
      contestant2Score: 50,
      commentary: text.slice(0, 500),
    };
  }

  let winner = String(parsed.winner || 'draw');
  const c1Name = contestant1.displayName;
  const c2Name = contestant2.displayName;
  if (winner.toLowerCase() !== 'draw'
    && winner.toLowerCase() !== c1Name.toLowerCase()
    && winner.toLowerCase() !== c2Name.toLowerCase()) {
    if (winner.toLowerCase().includes(c1Name.toLowerCase().split(' ')[0])) {
      winner = c1Name;
    } else if (winner.toLowerCase().includes(c2Name.toLowerCase().split(' ')[0])) {
      winner = c2Name;
    } else {
      winner = 'draw';
    }
  } else if (winner.toLowerCase() === c1Name.toLowerCase()) {
    winner = c1Name;
  } else if (winner.toLowerCase() === c2Name.toLowerCase()) {
    winner = c2Name;
  }

  return {
    winner,
    contestant1Score: Math.max(0, Math.min(100, Number(parsed.contestant1Score) || 50)),
    contestant2Score: Math.max(0, Math.min(100, Number(parsed.contestant2Score) || 50)),
    commentary: String(parsed.commentary || '').slice(0, 1000),
  };
}

export function extractCode(response) {
  const text = String(response || '');
  const codeMatch = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  if (codeMatch) return codeMatch[1].trim();
  return text.trim();
}
