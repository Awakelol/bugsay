// Bugsay booking rules, ported from app.py / data.py. Pure functions plus the
// two D1 queries, so they can be tested in Node with a SQLite stand-in.
import D from "./generated/data.js";

export const TRIPS = D.trips;
export const TRIPS_BY_ID = Object.fromEntries(D.trips.map((t) => [t.id, t]));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PLATE_RE = /^[A-Z0-9][A-Z0-9 -]{1,11}$/;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 letters, no 0/O or 1/I
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIMEZONE = "Asia/Manila";

// ------------------------------------------------------------------ dates

/** Today's date in the Philippines as YYYY-MM-DD (Workers run on UTC). */
export function today(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(now);
}

/** Philippine local time without zone, like Python's datetime.now().isoformat(). */
export function localTimestamp(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
        timeZone: TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(now).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** "2026-11-19" -> same string if it's a real date, else null. */
export function parseDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1 ? value : null;
}

export function addDays(iso, days) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Python weekday(): Monday = 0. */
export function weekday(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// ------------------------------------------------------------------- data

export function runsOn(trip, iso) { return trip.days.includes(weekday(iso)); }

export function daysLabel(days) {
    const set = new Set(days);
    if (set.size === 7) return "Daily";
    const missing = [0, 1, 2, 3, 4, 5, 6].filter((d) => !set.has(d));
    if (missing.length === 1) return `Daily except ${DAY_NAMES[missing[0]]}`;
    return [...set].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(", ");
}

export function discountedPrice(price) { return Math.round(price * (1 - D.discountRate)); }

export function sailingStatus(tripId, iso = null) {
    const find = (date) => D.sailingStatus.find((s) => s.date === date && s.trip_id === tripId);
    const entry = (iso && find(iso)) || find("*") || { status: "scheduled" };
    const status = entry.status;
    return {
        status,
        label: D.statusLabels[status] || status.charAt(0).toUpperCase() + status.slice(1),
        note: entry.note ?? null,
        bookable: status !== "cancelled",
    };
}

const seatCapacity = (trip, type) => D.seatCapacity[trip.id]?.[type] ?? D.demoSeats;
const vehicleCapacity = (trip, type) => D.vehicleCapacity[trip.id]?.[type] ?? D.demoSlots;

export function tripsForRoute(origin, destination) {
    return TRIPS.filter((t) => t.origin === origin && t.destination === destination)
        .sort((a, b) => (a.depart < b.depart ? -1 : a.depart > b.depart ? 1 : 0));
}

// ---------------------------------------------------------------- pricing

export function priceBooking(trip, fareClass, passengers, vehicles) {
    const fare = trip.fares.find((f) => f.type === fareClass);
    const rates = Object.fromEntries(trip.vehicles.map((v) => [v.type, v.price]));
    const lines = [];
    for (const p of passengers) {
        const price = fare.price;
        const discount = D.passengerTypes[p.type].discounted ? price - discountedPrice(price) : 0;
        lines.push({ kind: "passenger", price, discount, fee: D.feeTicket });
    }
    for (const v of vehicles) lines.push({ kind: "vehicle", price: rates[v.type], discount: 0, fee: D.feeVehicle });
    const sum = (list, key) => list.reduce((n, ln) => n + ln[key], 0);
    const fareTotal = sum(lines.filter((ln) => ln.kind === "passenger"), "price");
    const vehicleTotal = sum(lines.filter((ln) => ln.kind === "vehicle"), "price");
    const discountTotal = sum(lines, "discount");
    const serviceFee = sum(lines, "fee");
    return {
        lines, fare_total: fareTotal, vehicle_total: vehicleTotal, discount_total: discountTotal,
        service_fee: serviceFee, total: fareTotal + vehicleTotal - discountTotal + serviceFee,
    };
}

// ----------------------------------------------------------- availability

/** {trip_id: {seats: {class: n}, vehicles: {type: n}}} for one date. */
export async function bookedCounts(db, iso, tripIds) {
    if (!tripIds.length) return {};
    const sql = "SELECT x.trip_id, t.kind, COALESCE(t.accommodation, t.category) AS bucket, COUNT(*) AS n " +
        "FROM tickets t JOIN transactions x ON x.reference = t.reference " +
        `WHERE x.travel_date = ? AND x.trip_id IN (${tripIds.map(() => "?").join(",")}) ` +
        "GROUP BY x.trip_id, t.kind, bucket";
    const { results } = await db.prepare(sql).bind(iso, ...tripIds).all();
    const counts = {};
    for (const row of results) {
        const entry = counts[row.trip_id] ??= { seats: {}, vehicles: {} };
        entry[row.kind === "passenger" ? "seats" : "vehicles"][row.bucket] = row.n;
    }
    return counts;
}

export function availabilityFor(trip, iso, counts) {
    const taken = counts[trip.id] || { seats: {}, vehicles: {} };
    const status = sailingStatus(trip.id, iso);
    const seats = [...trip.fares].sort((a, b) => a.price - b.price).map((f) => {
        const capacity = seatCapacity(trip, f.type);
        const left = status.bookable ? Math.max(capacity - (taken.seats[f.type] || 0), 0) : 0;
        return { type: f.type, price: f.price, capacity, left };
    });
    const vehicles = trip.vehicles.map((v) => {
        const capacity = vehicleCapacity(trip, v.type);
        const left = status.bookable ? Math.max(capacity - (taken.vehicles[v.type] || 0), 0) : 0;
        return { type: v.type, price: v.price, capacity, left };
    });
    return {
        status, seats, vehicles,
        demo: !(trip.id in D.seatCapacity),
        seats_left: seats.reduce((n, s) => n + s.left, 0),
        seats_total: seats.reduce((n, s) => n + s.capacity, 0),
    };
}

// ------------------------------------------------------------- validation

const str = (v) => (v == null || v === false || v === 0 || v === "" ? "" : String(v));
const chars = (s) => [...s].length;  // code points, like Python len()

/** Returns [cleaned, errors]; mirrors validate_booking in app.py. */
export function validateBooking(body, todayIso = today()) {
    const errors = {};
    const trip = typeof body.trip_id === "string" ? TRIPS_BY_ID[body.trip_id] : undefined;
    if (!trip || !Object.hasOwn(TRIPS_BY_ID, body.trip_id)) return [null, { trip_id: "That sailing no longer exists." }];

    const date = parseDate(body.date);
    if (date === null) errors.date = "Choose a travel date.";
    else if (date < todayIso) errors.date = "That date has already passed.";
    else if (date > addDays(todayIso, D.bookingWindowDays)) errors.date = `You can book up to ${D.bookingWindowDays} days ahead.`;
    else if (!runsOn(trip, date)) errors.date = `This sailing runs ${daysLabel(trip.days)} only.`;
    else if (!sailingStatus(trip.id, date).bookable) errors.date = "This sailing is cancelled and can't be booked.";

    let passengers = body.passengers || [];
    if (!Array.isArray(passengers) || passengers.length > D.maxPassengers) {
        errors.passengers = `Up to ${D.maxPassengers} passengers per booking.`;
        passengers = [];
    }
    const cleanPassengers = passengers.map((raw, i) => {
        const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const name = str(p.name).trim();
        const type = "type" in p ? p.type : "regular";
        if (chars(name) < 2 || chars(name) > 100) errors[`passengers.${i}.name`] = `Enter passenger ${i + 1}'s full name.`;
        if (typeof type !== "string" || !Object.hasOwn(D.passengerTypes, type)) errors[`passengers.${i}.type`] = "Choose a passenger type.";
        return { name, type };
    });

    const fareClass = body.fare_class;
    if (cleanPassengers.length && !trip.fares.some((f) => f.type === fareClass)) errors.fare_class = "Choose an accommodation.";

    let vehicles = body.vehicles || [];
    const rates = new Set(trip.vehicles.map((v) => v.type));
    if (!Array.isArray(vehicles) || vehicles.length > D.maxVehicles) {
        errors.vehicles = `Up to ${D.maxVehicles} vehicles per booking.`;
        vehicles = [];
    }
    if (vehicles.length && !rates.size) {
        errors.vehicles = "This sailing doesn't carry vehicles.";
        vehicles = [];
    }
    const cleanVehicles = vehicles.map((raw, i) => {
        const v = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const type = v.type;
        const plate = str(v.plate).trim().toUpperCase().replace(/\s+/g, " ");
        const cargo = [...str(v.cargo).trim()].slice(0, 120).join("");
        if (!rates.has(type)) errors[`vehicles.${i}.type`] = "This sailing doesn't take that vehicle type.";
        if (!PLATE_RE.test(plate)) errors[`vehicles.${i}.plate`] = `Enter vehicle ${i + 1}'s plate number.`;
        return { type, plate, cargo };
    });

    if (!cleanPassengers.length && !cleanVehicles.length && !("passengers" in errors)) {
        errors.passengers = "Add at least one passenger or vehicle.";
    }

    const email = str(body.email).trim();
    if (chars(email) > 254 || !EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
    const paymentMethod = body.payment_method;
    if (typeof paymentMethod !== "string" || !Object.hasOwn(D.paymentMethods, paymentMethod)) {
        errors.payment_method = "Choose how you'll pay.";
    }

    return [{
        trip, date, fare_class: cleanPassengers.length ? fareClass : null,
        passengers: cleanPassengers, vehicles: cleanVehicles, email, payment_method: paymentMethod,
    }, errors];
}

export function capacityError(avail, b) {
    if (b.passengers.length) {
        const left = avail.seats.find((s) => s.type === b.fare_class).left;
        if (left < b.passengers.length) {
            if (!left) return { fare_class: `${b.fare_class} is sold out.` };
            return { fare_class: `Only ${left} ${b.fare_class} seat${left !== 1 ? "s" : ""} left.` };
        }
    }
    for (const vt of new Set(b.vehicles.map((v) => v.type))) {
        const wanted = b.vehicles.filter((v) => v.type === vt).length;
        const left = avail.vehicles.find((v) => v.type === vt).left;
        if (left < wanted) return { vehicles: `Only ${left} ${vt} slot${left !== 1 ? "s" : ""} left.` };
    }
    return null;
}

export function newReference() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return "BG-" + [...bytes].map((b) => REF_ALPHABET[b & 31]).join("");
}

export { D as DATA };
