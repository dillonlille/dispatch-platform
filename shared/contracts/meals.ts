import type { Punch } from './workforce.js';
export interface CortexMeal {
  mealId: string;
  itineraryId: string;
  cortexId: string;
  driverName: string;
  station: string;
  timezone: string;
  collectedAt: string;
  lastDelivery: string | null;
  start: string;
  end: string | null;
  firstDelivery: string | null;
  beforeStatus: string;
  afterStatus: string;
  // The Cortex itinerary page the meal was read from; null before links were retained.
  sourceUrl?: string | null;
}
export interface MealEmployee {
  id: string;
  name: string;
  paycom: {
    employeeCode: string;
    name: string;
    department?: string;
    status: string;
    punches: Punch[];
    sourceUrl?: string | null;
  } | null;
  cortex: CortexMeal[];
}
export interface EmployeeLink {
  id: string;
  cortexId: string;
  paycomCode: string;
}
export interface MealComparison {
  date: string;
  timezone: string;
  rows: MealEmployee[];
  paycomCollectedAt: string | null;
  cortexPublications: { station: string; timezone: string; collectedAt: string }[];
  employees: { code: string; name: string }[];
  drivers: {
    id: string;
    name: string;
    paycomCode: string | null;
    matchType: 'name' | 'saved' | 'separate' | 'unmatched';
  }[];
  links: { revision: number; links: EmployeeLink[]; separate?: string[] };
}
