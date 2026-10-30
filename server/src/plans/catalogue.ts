import type { SupplierOffering } from './types.js';

export const INITIAL_CATALOGUE: SupplierOffering[] = [
  {
    id: 'riverside-stall', supplierId: 'riverside-market', supplierName: 'Riverside Market', name: 'Riverside stall',
    serviceCategory: 'STALL', priceCents: 18_000, currency: 'USD', slots: [{ id: 'event-day', label: 'Event day' }],
    capacity: 2, capabilities: ['electricity'], requirements: [], availabilityStatus: 'AVAILABLE', version: 1
  },
  {
    id: 'garden-stall', supplierId: 'garden-market', supplierName: 'Garden Market', name: 'Garden stall',
    serviceCategory: 'STALL', priceCents: 16_000, currency: 'USD', slots: [{ id: 'event-day', label: 'Event day' }],
    capacity: 2, capabilities: [], requirements: [], availabilityStatus: 'AVAILABLE', version: 1
  },
  {
    id: 'premium-stall', supplierId: 'premium-market', supplierName: 'Premium Market', name: 'Premium stall',
    serviceCategory: 'STALL', priceCents: 26_500, currency: 'USD', slots: [{ id: 'event-day', label: 'Event day' }],
    capacity: 1, capabilities: ['electricity'], requirements: [], availabilityStatus: 'AVAILABLE', version: 1
  },
  {
    id: 'backup-electric-stall', supplierId: 'backup-market', supplierName: 'Backup Market', name: 'Simulated backup electric stall',
    serviceCategory: 'STALL', priceCents: 20_000, currency: 'USD', slots: [{ id: 'event-day', label: 'Event day' }],
    capacity: 2, capabilities: ['electricity'], requirements: [], availabilityStatus: 'AVAILABLE', version: 1
  },
  {
    id: 'refrigerated-display', supplierId: 'cold-chain-rentals', supplierName: 'Cold Chain Rentals', name: 'Refrigerated display rental',
    serviceCategory: 'REFRIGERATION', priceCents: 22_000, currency: 'USD', slots: [{ id: 'event-day', label: 'Event day' }],
    capacity: 2, capabilities: [], requirements: [{ kind: 'CAPABILITY', capability: 'electricity', providerCategory: 'STALL' }], availabilityStatus: 'AVAILABLE', version: 1
  },
  {
    id: 'morning-delivery', supplierId: 'sunrise-logistics', supplierName: 'Sunrise Logistics', name: 'Morning delivery',
    serviceCategory: 'DELIVERY', priceCents: 14_000, currency: 'USD', slots: [{ id: 'event-day', label: 'Event day', arrivalTime: '07:30' }],
    capacity: 3, capabilities: [], requirements: [], availabilityStatus: 'AVAILABLE', version: 1
  },
  {
    id: 'late-delivery', supplierId: 'sunrise-logistics', supplierName: 'Sunrise Logistics', name: 'Late delivery',
    serviceCategory: 'DELIVERY', priceCents: 10_000, currency: 'USD', slots: [{ id: 'event-day', label: 'Event day', arrivalTime: '09:30' }],
    capacity: 3, capabilities: [], requirements: [], availabilityStatus: 'AVAILABLE', version: 1
  }
];

export const REFERENCE_PLAN_OFFERING_IDS = ['riverside-stall', 'refrigerated-display', 'morning-delivery'];
