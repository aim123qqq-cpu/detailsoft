import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Booking, BookingQuote, Customer, QuoteSelection, Vehicle } from '@df/types';

export type DraftCustomer = Pick<Customer, 'id' | 'name' | 'phoneDisplay'>;
export type DraftVehicle = Pick<Vehicle, 'id' | 'make' | 'model' | 'generation' | 'plate' | 'color' | 'bodyType'> & { tenantClass?: string | null };

/** A new booking as it is put together across the steps: search, vehicle, services, time. */
export type BookingDraft = {
  channel: string;
  customer: DraftCustomer | null;
  vehicle: DraftVehicle | null;
  selections: QuoteSelection[];
  quote: BookingQuote | null;
  booking: Booking | null;
  /** Grows with every fresh start, so the search screen starts empty again. */
  round: number;
};

const EMPTY: BookingDraft = { channel: 'call', customer: null, vehicle: null, selections: [], quote: null, booking: null, round: 0 };

const Context = createContext<{ draft: BookingDraft; update: (patch: Partial<BookingDraft>) => void; reset: (start?: Partial<BookingDraft>) => void } | null>(null);

export function BookingDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<BookingDraft>(EMPTY);
  const update = (patch: Partial<BookingDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const reset = (start: Partial<BookingDraft> = {}) => setDraft((current) => ({ ...EMPTY, ...start, round: current.round + 1 }));
  return <Context.Provider value={{ draft, update, reset }}>{children}</Context.Provider>;
}

export function useBookingDraft() {
  const value = useContext(Context);
  if (!value) throw new Error('useBookingDraft outside BookingDraftProvider');
  return value;
}
