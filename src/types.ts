export type Vehicle = {
  id: string;
  make: string;
  model: string;
  generation?: string | null;
  bodyType?: string | null;
  plate: string;
  color: string;
  status: 'active' | 'inactive' | 'sold';
  active: boolean;
  tenantClass?: string | null;
};

export type Customer = {
  id: string;
  name: string;
  phoneDisplay: string;
  visitCount: number;
  vehicles: Vehicle[];
};

export type CatalogVariant = {
  id: string;
  make: string;
  model: string;
  generation?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  bodyType: string;
  systemVehicleClass?: string | null;
};

export type ApiError = { error: { code: string; message: string } };
