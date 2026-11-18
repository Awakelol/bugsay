// Bugsay on Cloudflare Workers. Pages are prebuilt static files (cloudflare/build.py);
// this Worker answers /api/*, the "My trip" lookup and /booking/<reference>,
// and stores bookings in D1.
import {
    DATA, TRIPS, TRIPS_BY_ID, availabilityFor, bookedCounts, capacityError, localTimestamp, newReference,
    parseDate, priceBooking, runsOn, today, tripsForRoute, validateBooking,
} from "./logic.js";
import { renderBooking } from "./booking.js";
import SHELLS from "./generated/shells.js";

const SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS },
    });
}

function html(body, status = 200) {
    return new Response(body, {
        status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
    });
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeHtml =(s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Tables are created on first use, so a fresh D1 database needs no migration step.
const schemaReady = new WeakMap();
function ensureSchema(db) {
    if (!schemaReady.has(db)) {
        schemaReady.set(db, db.batch(
            (DATA.schema + "CREATE TABLE IF NOT EXISTS capacity_guard (ok INTEGER NOT NULL CHECK (ok = 1));")
                .split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)),
        ).catch((err) => { schemaReady.delete(db); throw err; }));
    }
    return schemaReady.get(db);
}

// ------------------------------------------------------------------- API

function apiRoutes() {
    return json({ ports: DATA.ports, routes: DATA.routes, vehicle_routes: DATA.vehicleRoutes });
}

async function apiTrips(db, q) {
    const origin = q.get("origin") || "", destination = q.get("destination") || "";
    if (!Object.hasOwn(DATA.ports, origin) || !Object.hasOwn(DATA.ports, destination)) return json({ error: "Unknown port." }, 400);
    if (origin === destination) return json({ error: "Origin and destination must be different." }, 400);

    let trips = tripsForRoute(origin, destination);
    if (q.get("mode") === "vehicle") trips = trips.filter((t) => t.vehicles.length);
    const day = parseDate(q.get("date"));
    if (q.get("date") && day === null) return json({ error: "Date must be YYYY-MM-DD." }, 400);

    const running = trips.filter((t) => day === null || runsOn(t, day));
    const otherDays = trips.filter((t) => !running.includes(t));
    const counts = day && running.length ? await bookedCounts(db, day, running.map((t) => t.id)) : {};
    return json({
        origin, destination, date: day,
        trips: running.map((t) => (day ? { ...t, availability: availabilityFor(t, day, counts) } : t)),
        other_days: otherDays,
    });
}

async function apiAvailability(db, q) {
    const day = parseDate(q.get("date")) || today();
    const origin = q.get("origin") || null, destination = q.get("destination") || null;
    const trips = TRIPS.filter((t) => runsOn(t, day) && (origin === null || t.origin === origin)
        && (destination === null || t.destination === destination))
        .sort((a, b) => cmp(a.depart, b.depart) || cmp(a.company, b.company));
    const counts = trips.length ? await bookedCounts(db, day, trips.map((t) => t.id)) : {};
    const sailings = trips.map((t) => ({ ...t, availability: availabilityFor(t, day, counts) }));
    const going = sailings.filter((s) => s.availability.status.bookable);
    return json({
        date: day,
        generated_at: new Date().toISOString().slice(0, 19) + "Z",
        sailings,
        totals: { // seat totals only count sailings that are actually going
            sailings: sailings.length,
            seats_left: going.reduce((n, s) => n + s.availability.seats_left, 0),
            seats_total: going.reduce((n, s) => n + s.availability.seats_total, 0),
            cancelled: sailings.length - going.length,
        },
    });
}

// D1 has no interactive transactions, so the whole booking is one batch (which
// D1 runs atomically) ending in a guard row that fails its CHECK if any bucket
// went over capacity. That rolls the batch back, so two people can't both get
// the last seat.
function guardStatement(db, b) {
    const conds = [], args = [];
    const count = "(SELECT COUNT(*) FROM tickets t JOIN transactions x ON x.reference = t.reference " +
        "WHERE x.trip_id = ? AND x.travel_date = ? AND ";
    if (b.passengers.length) {
        const cap = availabilityFor(b.trip, b.date, {}).seats.find((s) => s.type === b.fare_class).capacity;
        conds.push(count + "t.kind = 'passenger' AND t.accommodation = ?) <= ?");
        args.push(b.trip.id, b.date, b.fare_class, cap);
    }
    for (const vt of new Set(b.vehicles.map((v) => v.type))) {
        const cap = availabilityFor(b.trip, b.date, {}).vehicles.find((v) => v.type === vt).capacity;
        conds.push(count + "t.kind = 'vehicle' AND t.category = ?) <= ?");
        args.push(b.trip.id, b.date, vt, cap);
    }
    return db.prepare(`INSERT INTO capacity_guard (ok) SELECT CASE WHEN ${conds.join(" AND ")} THEN 1 ELSE 0 END`)
        .bind(...args);
}

async function apiCreateBooking(db, request) {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ errors: { form: "Send the booking as JSON." } }, 400);
    }
    const [b, errors] = validateBooking(body);
    if (Object.keys(errors).length) return json({ errors }, 400);

    const { trip, date } = b;
    const quote = priceBooking(trip, b.fare_class, b.passengers, b.vehicles);
    const conflict = async () => {
        const avail = availabilityFor(trip, date, await bookedCounts(db, date, [trip.id]));
        return json({ errors: capacityError(avail, b) || { form: "Those seats were just taken. Try again." }, availability: avail }, 409);
    };

    // Friendly check first; the guard below is what actually prevents overbooking.
    const before = availabilityFor(trip, date, await bookedCounts(db, date, [trip.id]));
    if (capacityError(before, b)) return conflict();

    const rows = [
        ...b.passengers.map((p) => ["passenger", p.name, p.type, b.fare_class, null]),
        ...b.vehicles.map((v) => ["vehicle", v.plate, v.type, null, v.cargo || null]),
    ];
    for (let attempt = 0; attempt < 5; attempt++) {
        const reference = newReference();
        const statements = [
            db.prepare("INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(
                reference, trip.id, date, b.fare_class, b.email, b.payment_method, quote.fare_total,
                quote.discount_total, quote.vehicle_total, quote.service_fee, quote.total, localTimestamp()),
            ...rows.map((row, i) => db.prepare(
                "INSERT INTO tickets (reference, seq, kind, holder, category, accommodation, cargo, price, discount, fee) " +
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ).bind(reference, i + 1, ...row, quote.lines[i].price, quote.lines[i].discount, quote.lines[i].fee)),
            guardStatement(db, b),
            db.prepare("DELETE FROM capacity_guard"),
        ];
        try {
            await db.batch(statements);
        } catch (err) {
            const msg = String(err && (err.cause?.message || err.message));
            if (/CHECK constraint failed/i.test(msg)) return conflict();
            if (/UNIQUE constraint failed: transactions\.reference/i.test(msg)) continue;  // reference clash: new code
            throw err;
        }
        return json({ reference, total: quote.total, tickets: rows.length, url: `/booking/${reference}` }, 201);
    }
    throw new Error("Couldn't generate a unique booking reference.");
}

// ----------------------------------------------------------------- pages

async function bookingPage(db, reference) {
    const tx = await db.prepare("SELECT * FROM transactions WHERE reference = ?").bind(reference.toUpperCase()).first();
    const trip = tx && TRIPS_BY_ID[tx.trip_id];
    if (!tx || !trip) {
        return html(SHELLS.missing.replaceAll(SHELLS.missingRef, escapeHtml(reference)), 404);
    }
    const { results: tickets } = await db.prepare("SELECT * FROM tickets WHERE reference = ? ORDER BY seq")
        .bind(tx.reference).all();
    const content = renderBooking({
        tx, trip, ports: DATA.ports, passengerTypes: DATA.passengerTypes, vehicleIcons: DATA.vehicleIcons,
        payment: DATA.paymentMethods[tx.payment_method], discountPct: Math.trunc(DATA.discountRate * 100),
        passengers: tickets.filter((t) => t.kind === "passenger"),
        vehicles: tickets.filter((t) => t.kind === "vehicle"),
    });
    const page = SHELLS.myTrip
        .replace(/<title>[^<]*<\/title>/, `<title>Booking ${escapeHtml(tx.reference)} | Bugsay</title>`)
        .replace(/(<main id="main">)[\s\S]*?(<\/main>)/, (_, open, close) => `${open}\n${content}\n    ${close}`);
    return html(page);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;
        try {
            if (path.startsWith("/api/")) {
                if (path === "/api/routes" && method === "GET") return apiRoutes();
                await ensureSchema(env.DB);
                if (path === "/api/trips" && method === "GET") return await apiTrips(env.DB, url.searchParams);
                if (path === "/api/availability" && method === "GET") return await apiAvailability(env.DB, url.searchParams);
                if (path === "/api/bookings" && method === "POST") return await apiCreateBooking(env.DB, request);
                return json({ error: "Not found." }, 404);
            }
            if (path === "/my-trip") {
                let ref = (url.searchParams.get("ref") || "").trim().toUpperCase();
                if (ref) {
                    if (!ref.startsWith("BG-")) ref = "BG-" + ref;
                    return Response.redirect(new URL(`/booking/${encodeURIComponent(ref)}`, url), 302);
                }
                return env.ASSETS.fetch(request);
            }
            const m = path.match(/^\/booking\/([^/]+)$/);
            if (m) {
                await ensureSchema(env.DB);
                let reference;
                try { reference = decodeURIComponent(m[1]); } catch { reference = m[1]; }
                return await bookingPage(env.DB, reference);
            }
            return env.ASSETS.fetch(request);
        } catch (err) {
            console.error(err);
            if (path.startsWith("/api/")) return json({ error: "Something went wrong. Try again." }, 500);
            return html("<!doctype html><title>Error | Bugsay</title><p>Something went wrong. Try again.</p>", 500);
        }
    },
};
