/**
 * The mobile app expects `price` on services and `total` on bookings.
 * The Prisma schema uses `basePrice` and `finalAmount`.
 * Rather than renaming columns (a migration) or editing every screen,
 * these helpers add read-only aliases onto the API response so both
 * naming conventions work. Safe to apply on top of any Prisma result
 * that includes a `service` or booking `items` relation.
 */

export function withServiceAlias<T extends { basePrice?: number }>(
  service: T | null | undefined,
): (T & { price?: number }) | null | undefined {
  if (!service) return service;
  return { ...service, price: service.basePrice };
}

export function withBookingAlias<
  T extends {
    finalAmount?: number;
    items?: { service?: any }[];
  },
>(booking: T | null | undefined): (T & { total?: number }) | null | undefined {
  if (!booking) return booking;
  return {
    ...booking,
    total: booking.finalAmount,
    items: booking.items?.map((item) => ({
      ...item,
      service: withServiceAlias(item.service),
    })),
  };
}

export function withBookingAliasList<
  T extends { finalAmount?: number; items?: { service?: any }[] },
>(bookings: T[]): (T & { total?: number })[] {
  return bookings.map((b) => withBookingAlias(b)!);
}

export function withServiceAliasList<T extends { basePrice?: number }>(
  services: T[],
): (T & { price?: number })[] {
  return services.map((s) => withServiceAlias(s)!);
}