import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type LocationSuggestion = {
  display_name: string;
  address: {
    road: string;
    suburb: string;
    state: string;
    postcode: string;
    country: string;
  };
};

type GeoapifyAutocompleteResult = {
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  housenumber?: string;
  street?: string;
  name?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  state_code?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
};

type GeoapifyAutocompleteResponse = {
  results?: GeoapifyAutocompleteResult[];
};

const COUNTRY_CODES: Record<string, string> = {
  australia: 'au',
  'new zealand': 'nz',
  'united kingdom': 'gb',
  'united states': 'us',
  canada: 'ca',
  singapore: 'sg',
  ireland: 'ie',
  'south africa': 'za',
  germany: 'de',
  france: 'fr',
  japan: 'jp',
  italy: 'it',
  spain: 'es',
  netherlands: 'nl',
  sweden: 'se',
  switzerland: 'ch',
};

const AUSTRALIAN_STATE_CODES: Record<string, string> = {
  'new south wales': 'NSW',
  victoria: 'VIC',
  queensland: 'QLD',
  'western australia': 'WA',
  'south australia': 'SA',
  tasmania: 'TAS',
  'australian capital territory': 'ACT',
  'northern territory': 'NT',
};

function normaliseCountryCode(country: string | null) {
  const value = country?.trim().toLowerCase();
  if (!value) return 'au';
  if (/^[a-z]{2}$/.test(value)) return value;
  return COUNTRY_CODES[value] || undefined;
}

function normaliseState(state: string | undefined, stateCode: string | undefined, countryCode: string | undefined) {
  if (countryCode !== 'au') {
    return stateCode || state || '';
  }

  const code = stateCode?.trim().toUpperCase();
  if (code && Object.values(AUSTRALIAN_STATE_CODES).includes(code)) {
    return code;
  }

  const stateName = state?.trim().toLowerCase();
  return stateName ? AUSTRALIAN_STATE_CODES[stateName] || state || '' : '';
}

function formatRoad(result: GeoapifyAutocompleteResult) {
  if (typeof result.address_line1 === 'string' && result.address_line1.trim()) {
    return result.address_line1.trim();
  }

  const street = [result.housenumber, result.street].filter(Boolean).join(' ').trim();
  return street || result.name || '';
}

function toSuggestion(result: GeoapifyAutocompleteResult): LocationSuggestion {
  const countryCode = typeof result.country_code === 'string' ? result.country_code.toLowerCase() : undefined;
  const suburb = result.suburb || result.city || result.town || result.village || result.county || '';

  return {
    display_name: result.formatted || [result.address_line1, result.address_line2].filter(Boolean).join(', '),
    address: {
      road: formatRoad(result),
      suburb,
      state: normaliseState(result.state, result.state_code, countryCode),
      postcode: result.postcode || '',
      country: result.country || '',
    },
  };
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Location autocomplete is not configured. Set GEOAPIFY_API_KEY on the server.' },
      { status: 503 }
    );
  }

  const query = req.nextUrl.searchParams.get('q')?.trim() || '';
  if (query.length < 3) {
    return NextResponse.json({ suggestions: [] });
  }

  const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  url.searchParams.set('text', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '5');
  url.searchParams.set('apiKey', apiKey);

  const countryCode = normaliseCountryCode(req.nextUrl.searchParams.get('country'));
  if (countryCode) {
    url.searchParams.set('filter', `countrycode:${countryCode}`);
    url.searchParams.set('bias', `countrycode:${countryCode}`);
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Geoapify autocomplete failed with status ${response.status}` },
        { status: 502 }
      );
    }

    const payload = (await response.json()) as GeoapifyAutocompleteResponse;
    const suggestions = Array.isArray(payload.results)
      ? payload.results.map(toSuggestion).filter((suggestion: LocationSuggestion) => suggestion.display_name)
      : [];

    return NextResponse.json({ suggestions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Location autocomplete request failed' },
      { status: 502 }
    );
  }
}
