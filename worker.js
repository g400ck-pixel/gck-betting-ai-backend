// GCK Betting AI Backend - Cloudflare Worker
// Sources: The Odds API + BallDontLie
// Runtime secrets required: ODDS_API_KEY, BALLDONTLIE_API_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  ...CORS_HEADERS,
};

const ODDS_SPORT_KEYS = {
  mlb: 'baseball_mlb',
  nba: 'basketball_nba',
  nfl: 'americanfootball_nfl',
  nhl: 'icehockey_nhl',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data?.error || data?.message || data?.raw || `HTTP ${res.status}`,
      data,
    };
  }

  return { ok: true, status: res.status, data };
}

async function getOdds(env, sport = 'mlb') {
  if (!env.ODDS_API_KEY) {
    return { ok: false, error: 'Missing ODDS_API_KEY runtime secret' };
  }

  const sportKey = ODDS_SPORT_KEYS[String(sport).toLowerCase()] || sport;
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`);
  url.searchParams.set('apiKey', env.ODDS_API_KEY);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'h2h,spreads,totals');
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  return fetchJson(url.toString());
}

async function getBallDontLieGames(env, date = todayET()) {
  if (!env.BALLDONTLIE_API_KEY) {
    return { ok: false, error: 'Missing BALLDONTLIE_API_KEY runtime secret' };
  }

  const url = new URL('https://api.balldontlie.io/v1/games');
  url.searchParams.append('dates[]', date);
  url.searchParams.set('per_page', '100');

  return fetchJson(url.toString(), {
    headers: { Authorization: env.BALLDONTLIE_API_KEY },
  });
}

function americanToImpliedPct(price) {
  if (typeof price !== 'number') return null;
  if (price > 0) return Number(((100 / (price + 100)) * 100).toFixed(2));
  return Number((((-price) / ((-price) + 100)) * 100).toFixed(2));
}

function getBestSpread(bookmakers, teamName) {
  let best = null;

  for (const book of bookmakers || []) {
    const market = (book.markets || []).find((m) => m.key === 'spreads');
    if (!market) continue;

    const outcome = (market.outcomes || []).find((o) => o.name === teamName);
    if (!outcome) continue;

    const row = {
      book: book.title || book.key,
      team: outcome.name,
      point: outcome.point,
      price: outcome.price,
      impliedProbability: americanToImpliedPct(outcome.price),
    };

    if (!best || row.price > best.price) best = row;
  }

  return best;
}

function cleanOddsGame(game) {
  return {
    id: game.id,
    sport_key: game.sport_key,
    commence_time: game.commence_time,
    away_team: game.away_team,
    home_team: game.home_team,
    books_count: Array.isArray(game.bookmakers) ? game.bookmakers.length : 0,
    best_away_spread: getBestSpread(game.bookmakers, game.away_team),
    best_home_spread: getBestSpread(game.bookmakers, game.home_team),
  };
}

function runExpertWatchlist(expertId, oddsGames) {
  const expert = String(expertId || '478');

  const modelNames = {
    '478': 'Pitching Quality Divergence',
    '475': 'F5 Pure Pitching Divergence',
    '457': 'Starting Pitcher Dual-Leaking',
    '461': 'WHIP Leaking Starter',
    '455': 'ERA Leaking Starter',
    '500': 'Dominant Arm vs Cold Bats',
  };

  return oddsGames.map(cleanOddsGame).map((game) => {
    const spread = game.best_away_spread;
    const hasPlusRunline = spread && Number(spread.point) >= 1.5;
    const isExpert500 = expert === '500';

    return {
      expertId: expert,
      expertName: modelNames[expert] || 'GCK Expert Model',
      matchup: `${game.away_team} @ ${game.home_team}`,
      bet: isExpert500
        ? `${game.away_team} +1.5 full game`
        : `${game.away_team} F5 +1.5`,
      lineFound: spread || null,
      status: hasPlusRunline ? 'watchlist' : 'needs_sportsbook_line_check',
      confidence: hasPlusRunline ? 62 : 50,
      filtersPassed: hasPlusRunline ? ['Away +1.5 full-game spread available from Odds API'] : [],
      filtersMissing: [
        'Probable starters',
        'TTOP2 xwOBA-against',
        'TTOP3 xwOBA-against',
        'Home SP WHIP last 5 starts',
        'Home SP ERA last 5 starts',
        'Away SP first-inning K rate',
        'Home lineup EMA-14d wOBA',
        'F5 spread market',
      ],
      reason:
        'Odds API supplies games and market lines. BallDontLie supplies NBA data. These APIs do not supply the MLB pitcher/lineup metrics required to fully grade this expert, so this route returns a watchlist until an MLB stats source is connected.',
    };
  });
}

async function scanMLB(env, expertId) {
  const oddsResult = await getOdds(env, 'mlb');

  if (!oddsResult.ok) {
    return {
      sport: 'MLB',
      status: 'error',
      source: 'The Odds API',
      error: oddsResult.error,
      note: 'Check ODDS_API_KEY and The Odds API plan/sport access.',
    };
  }

  const games = Array.isArray(oddsResult.data) ? oddsResult.data : [];

  return {
    sport: 'MLB',
    status: 'ok',
    source: 'The Odds API',
    date: todayET(),
    expertId: String(expertId || '478'),
    gamesFound: games.length,
    note: 'MLB expert models are in watchlist mode until an MLB stats source is added.',
    results: runExpertWatchlist(expertId, games),
  };
}

async function scanNBA(env) {
  const date = todayET();
  const [oddsResult, bdlResult] = await Promise.all([
    getOdds(env, 'nba'),
    getBallDontLieGames(env, date),
  ]);

  const oddsGames = oddsResult.ok && Array.isArray(oddsResult.data) ? oddsResult.data : [];
  const bdlGames = bdlResult.ok && Array.isArray(bdlResult.data?.data) ? bdlResult.data.data : [];

  return {
    sport: 'NBA',
    status: oddsResult.ok || bdlResult.ok ? 'ok' : 'error',
    date,
    sources: ['The Odds API', 'BallDontLie'],
    errors: {
      oddsApi: oddsResult.ok ? null : oddsResult.error,
      ballDontLie: bdlResult.ok ? null : bdlResult.error,
    },
    gamesFound: {
      oddsApi: oddsGames.length,
      ballDontLie: bdlGames.length,
    },
    oddsGames: oddsGames.map(cleanOddsGame),
    ballDontLieGames: bdlGames.map((g) => ({
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
  const url = new URL(request.url);
  let body = {};

  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  const sport = String(body.sport || url.searchParams.get('sport') || 'mlb').toLowerCase();
  const expertId = String(body.expertId || url.searchParams.get('expertId') || '478');

  if (sport === 'mlb') return json(await scanMLB(env, expertId));
  if (sport === 'nba') return json(await scanNBA(env));

  return json({ status: 'error', message: `Unsupported sport: ${sport}`, supported: ['mlb', 'nba'] }, 400);
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
          date: todayET(),
          routes: {
            health: '/api/health',
            mlbExpert: '/api/scan-games?sport=mlb&expertId=478',
            nba: '/api/scan-games?sport=nba',
          },
          secretsLoaded: {
            ODDS_API_KEY: Boolean(env.ODDS_API_KEY),
            BALLDONTLIE_API_KEY: Boolean(env.BALLDONTLIE_API_KEY),
          },
        });
      }

      if (url.pathname === '/api/scan-games') {
        return handleScan(request, env);
      }

      return json({ status: 'error', message: 'Route not found', path: url.pathname }, 404);
    } catch (error) {
      return json({
        status: 'error',
        message: error?.message || 'Unknown backend error',
        path: url.pathname,
      }, 500);
    }
  },
};
