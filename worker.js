// GCK Betting AI Backend - Cloudflare Worker
// Uses: The Odds API + BallDontLie API
// Secrets required in Cloudflare/GitHub:
// ODDS_API_KEY
// BALLDONTLIE_API_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
};

const ODDS_SPORT_KEYS = {
  mlb: 'baseball_mlb',
  nba: 'basketball_nba',
  nfl: 'americanfootball_nfl',
  nhl: 'icehockey_nhl',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function getTodayET() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}

async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Request failed ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return data;
}

async function getOdds(env, sport = 'mlb') {
  if (!env.ODDS_API_KEY) {
    throw new Error('Missing ODDS_API_KEY secret');
  }

  const sportKey = ODDS_SPORT_KEYS[sport.toLowerCase()] || sport;
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`);
  url.searchParams.set('apiKey', env.ODDS_API_KEY);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'h2h,spreads,totals');
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  return safeFetchJson(url.toString());
}

async function getBallDontLieNBAGames(env, date = getTodayET()) {
  if (!env.BALLDONTLIE_API_KEY) {
    throw new Error('Missing BALLDONTLIE_API_KEY secret');
  }

  const url = new URL('https://api.balldontlie.io/v1/games');
  url.searchParams.append('dates[]', date);
  url.searchParams.set('per_page', '100');

  return safeFetchJson(url.toString(), {
    headers: {
      Authorization: env.BALLDONTLIE_API_KEY,
    },
  });
}

function americanToImplied(odds) {
  if (typeof odds !== 'number') return null;
  if (odds > 0) return +(100 / (odds + 100) * 100).toFixed(2);
  return +((-odds) / ((-odds) + 100) * 100).toFixed(2);
}

function bestSpreadForTeam(bookmakers, teamName) {
  let best = null;

  for (const book of bookmakers || []) {
    const spreadMarket = (book.markets || []).find(m => m.key === 'spreads');
    if (!spreadMarket) continue;

    const outcome = (spreadMarket.outcomes || []).find(o => o.name === teamName);
    if (!outcome) continue;

    const candidate = {
      book: book.title || book.key,
      team: outcome.name,
      point: outcome.point,
      price: outcome.price,
      impliedProbability: americanToImplied(outcome.price),
    };

    // For +1.5, best is highest price. For negative spreads, still keep highest price.
    if (!best || candidate.price > best.price) best = candidate;
  }

  return best;
}

function summarizeOddsGame(game) {
  const awaySpread = bestSpreadForTeam(game.bookmakers, game.away_team);
  const homeSpread = bestSpreadForTeam(game.bookmakers, game.home_team);

  return {
    id: game.id,
    sport_key: game.sport_key,
    commence_time: game.commence_time,
    away_team: game.away_team,
    home_team: game.home_team,
    best_away_spread: awaySpread,
    best_home_spread: homeSpread,
    books_count: (game.bookmakers || []).length,
  };
}

function runGckDemoExpert(expertId, oddsGames) {
  // This uses odds data only. Your true MLB expert filters need pitcher stats
  // like TTOP xwOBA, WHIP last 5, ERA last 5, etc. Those are NOT included
  // in Odds API or BallDontLie. This returns watchlist candidates only.
  const results = [];

  for (const game of oddsGames.map(summarizeOddsGame)) {
    const awaySpread = game.best_away_spread;
    const qualifiesAwayPlus = awaySpread && awaySpread.point >= 1.5;

    results.push({
      expertId,
      matchup: `${game.away_team} @ ${game.home_team}`,
      recommendedBet: qualifiesAwayPlus
        ? `${game.away_team} +${awaySpread.point}`
        : `${game.away_team} F5 +1.5 / full game +1.5 needs sportsbook check`,
      status: qualifiesAwayPlus ? 'watchlist' : 'needs_line_check',
      confidence: qualifiesAwayPlus ? 62 : 50,
      line: awaySpread,
      filtersPassed: qualifiesAwayPlus ? ['Away +1.5 line available from Odds API'] : [],
      filtersMissing: [
        'Probable starters',
        'TTOP2 xwOBA-against',
        'TTOP3 xwOBA-against',
        'SP WHIP last 5 starts',
        'SP ERA last 5 starts',
        'First-inning K rate',
        'Lineup EMA-14d wOBA',
      ],
      reason: 'Odds API gives game odds, but not the pitcher/lineup metrics required to fully validate this expert model. Treat this as a betting line watchlist until MLB stat data is connected.',
    });
  }

  return results;
}

async function scanMLB(env, expertId = '478') {
  const oddsRaw = await getOdds(env, 'mlb');
  return {
    sport: 'MLB',
    source: 'The Odds API',
    expertId,
    date: getTodayET(),
    note: 'MLB expert models are in watchlist mode until an MLB stats source is added for pitcher/lineup metrics.',
    gamesFound: oddsRaw.length,
    results: runGckDemoExpert(expertId, oddsRaw),
  };
}

async function scanNBA(env) {
  const date = getTodayET();
  const [oddsRaw, bdlRaw] = await Promise.allSettled([
    getOdds(env, 'nba'),
    getBallDontLieNBAGames(env, date),
  ]);

  const odds = oddsRaw.status === 'fulfilled' ? oddsRaw.value : [];
  const bdlGames = bdlRaw.status === 'fulfilled' ? bdlRaw.value?.data || [] : [];

  return {
    sport: 'NBA',
    source: 'The Odds API + BallDontLie',
    date,
    oddsStatus: oddsRaw.status,
    ballDontLieStatus: bdlRaw.status,
    errors: {
      odds: oddsRaw.status === 'rejected' ? String(oddsRaw.reason?.message || oddsRaw.reason) : null,
      ballDontLie: bdlRaw.status === 'rejected' ? String(bdlRaw.reason?.message || bdlRaw.reason) : null,
    },
    gamesFound: {
      odds: odds.length,
      ballDontLie: bdlGames.length,
    },
    games: odds.map(summarizeOddsGame),
    ballDontLieGames: bdlGames.map(g => ({
      id: g.id,
      date: g.date,
      home_team: g.home_team?.full_name,
      visitor_team: g.visitor_team?.full_name,
      home_score: g.home_team_score,
      visitor_score: g.visitor_team_score,
      status: g.status,
    })),
  };
}

async function handleScan(request, env) {
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch (_) { body = {}; }
  }

  const url = new URL(request.url);
  const sport = (body.sport || url.searchParams.get('sport') || 'mlb').toLowerCase();
  const expertId = String(body.expertId || url.searchParams.get('expertId') || '478');

  if (sport === 'nba') return json(await scanNBA(env));
  if (sport === 'mlb') return json(await scanMLB(env, expertId));

  return json({
    status: 'error',
    message: `Unsupported sport: ${sport}`,
    supported: ['mlb', 'nba'],
  }, 400);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/' || url.pathname === '/api/health') {
        return json({
          status: 'ok',
          name: 'GCK Betting AI Backend',
          routes: ['/api/scan-games?sport=mlb&expertId=478', '/api/scan-games?sport=nba'],
          secretsLoaded: {
            ODDS_API_KEY: Boolean(env.ODDS_API_KEY),
            BALLDONTLIE_API_KEY: Boolean(env.BALLDONTLIE_API_KEY),
          },
        });
      }

      if (url.pathname === '/api/scan-games') {
        return handleScan(request, env);
      }

      return json({ status: 'error', message: 'Route not found' }, 404);
    } catch (err) {
      return json({
        status: 'error',
        message: err.message || 'Unknown backend error',
        path: url.pathname,
      }, 500);
    }
  },
};
