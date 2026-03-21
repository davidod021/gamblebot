import axios, { AxiosError } from 'axios';
import { getSessionToken } from './auth.js';
import { config } from '../config.js';
import type {
  MarketFilter,
  MarketCatalogue,
  MarketBook,
  PlaceInstruction,
  PlaceExecutionReport,
  CurrentOrderSummary,
  AccountFunds,
} from './types.js';

const BETTING_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const ACCOUNT_BASE = 'https://api.betfair.com/exchange/account/rest/v1.0';

async function apiPost<T>(baseUrl: string, endpoint: string, body: Record<string, unknown>): Promise<T> {
  const token = await getSessionToken();

  try {
    const response = await axios.post<T>(`${baseUrl}/${endpoint}/`, body, {
      headers: {
        'X-Application': config.betfair.appKey,
        'X-Authentication': token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    return response.data;
  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      throw new Error(
        `Betfair API error ${err.response.status} on ${endpoint}: ${JSON.stringify(err.response.data)}`,
      );
    }
    throw err;
  }
}

export async function listMarketCatalogue(
  filter: MarketFilter,
  maxResults = 20,
  sort: 'FIRST_TO_START' | 'MINIMUM_FIRST' | 'MAXIMUM_FIRST' = 'FIRST_TO_START',
): Promise<MarketCatalogue[]> {
  return apiPost<MarketCatalogue[]>(BETTING_BASE, 'listMarketCatalogue', {
    filter,
    marketProjection: ['EVENT', 'EVENT_TYPE', 'COMPETITION', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME'],
    maxResults,
    sort,
  });
}

export async function listMarketBook(marketIds: string[]): Promise<MarketBook[]> {
  return apiPost<MarketBook[]>(BETTING_BASE, 'listMarketBook', {
    marketIds,
    priceProjection: {
      priceData: ['EX_BEST_OFFERS'],
      exBestOffersOverrides: { bestPricesDepth: 3 },
    },
    matchProjection: 'NO_ROLLUP',
    currencyCode: 'GBP',
  });
}

export async function placeOrders(
  marketId: string,
  instructions: PlaceInstruction[],
  customerRef?: string,
): Promise<PlaceExecutionReport> {
  return apiPost<PlaceExecutionReport>(BETTING_BASE, 'placeOrders', {
    marketId,
    instructions,
    ...(customerRef && { customerRef }),
    currencyCode: 'GBP',
  });
}

export async function listCurrentOrders(fromRecord = 0, recordCount = 50): Promise<{
  currentOrders: CurrentOrderSummary[];
  moreAvailable: boolean;
}> {
  return apiPost(BETTING_BASE, 'listCurrentOrders', {
    orderProjection: 'ALL',
    dateRange: {},
    orderBy: 'BY_PLACE_TIME',
    sortDir: 'LATEST_TO_EARLIEST',
    fromRecord,
    recordCount,
  });
}

export async function getAccountFunds(): Promise<AccountFunds> {
  return apiPost<AccountFunds>(ACCOUNT_BASE, 'getAccountFunds', {});
}
