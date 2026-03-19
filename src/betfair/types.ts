export interface MarketFilter {
  eventTypeIds?: string[];
  marketCountries?: string[];
  marketStartTime?: { from?: string; to?: string };
  marketTypeCodes?: string[];
  competitionIds?: string[];
  textQuery?: string;
}

export interface Runner {
  selectionId: number;
  runnerName: string;
  handicap: number;
  sortPriority: number;
}

export interface MarketCatalogue {
  marketId: string;
  marketName: string;
  marketStartTime?: string;
  totalMatched?: number;
  event?: {
    id: string;
    name: string;
    countryCode?: string;
    venue?: string;
    openDate?: string;
    timezone?: string;
  };
  eventType?: { id: string; name: string };
  competition?: { id: string; name: string };
  runners?: Runner[];
}

export interface PriceSize {
  price: number;
  size: number;
}

export interface ExchangePrices {
  availableToBack: PriceSize[];
  availableToLay: PriceSize[];
  tradedVolume: PriceSize[];
}

export interface RunnerBook {
  selectionId: number;
  status: 'ACTIVE' | 'WINNER' | 'LOSER' | 'REMOVED' | 'HIDDEN' | 'PLACED';
  lastPriceTraded?: number;
  totalMatched?: number;
  ex?: ExchangePrices;
}

export interface MarketBook {
  marketId: string;
  isMarketDataDelayed: boolean;
  status: 'INACTIVE' | 'OPEN' | 'SUSPENDED' | 'CLOSED';
  betDelay: number;
  bspReconciled: boolean;
  complete: boolean;
  inplay: boolean;
  numberOfWinners: number;
  numberOfRunners: number;
  totalMatched: number;
  totalAvailable: number;
  runners: RunnerBook[];
}

export interface LimitOrder {
  size: number;
  price: number;
  persistenceType: 'LAPSE' | 'PERSIST' | 'MARKET_ON_CLOSE';
  timeInForce?: 'FILL_OR_KILL';
  minFillSize?: number;
  betTargetType?: 'BACKERS_PROFIT' | 'PAYOUT';
  betTargetSize?: number;
  customerOrderRef?: string;
}

export interface PlaceInstruction {
  orderType: 'LIMIT';
  selectionId: number;
  handicap?: number;
  side: 'BACK' | 'LAY';
  limitOrder: LimitOrder;
}

export interface PlaceInstructionReport {
  status: 'SUCCESS' | 'FAILURE' | 'TIMEOUT';
  errorCode?: string;
  instruction: PlaceInstruction;
  betId?: string;
  placedDate?: string;
  averagePriceMatched?: number;
  sizeMatched?: number;
}

export interface PlaceExecutionReport {
  customerRef?: string;
  status: 'SUCCESS' | 'FAILURE' | 'PROCESSED_WITH_ERRORS' | 'TIMEOUT';
  errorCode?: string;
  marketId?: string;
  instructionReports?: PlaceInstructionReport[];
}

export interface CurrentOrderSummary {
  betId: string;
  marketId: string;
  partitionedMarketId?: string;
  selectionId: number;
  handicap: number;
  priceSize: PriceSize;
  bspLiability: number;
  side: 'BACK' | 'LAY';
  status: 'EXECUTABLE' | 'EXECUTION_COMPLETE';
  persistenceType: string;
  orderType: string;
  placedDate: string;
  matchedDate?: string;
  averagePriceMatched?: number;
  sizeMatched?: number;
  sizeRemaining?: number;
  sizeLapsed?: number;
  sizeCancelled?: number;
  sizeVoided?: number;
  customerOrderRef?: string;
  customerStrategyRef?: string;
}

export interface AccountFunds {
  availableToBetBalance: number;
  exposure: number;
  retainedCommission: number;
  exposureLimit: number;
  discountRate?: number;
  pointsBalance?: number;
  wallet?: string;
}
