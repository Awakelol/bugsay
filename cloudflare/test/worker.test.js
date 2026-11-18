// Worker tests: the same cases as tests/test_app.py, run against a SQLite
// stand-in for D1 (node:sqlite, Node 22.5+). Run: npm test (in cloudflare/).
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../worker/index.js";
import { addDays, today, weekday } from "../worker/logic.js";

// ------------------------------------------------------------ D1 stand-in

class Statement {
    constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
    bind(...args) { return new Statement(this.db, this.sql, args); }
    async all() { await tick(); return { results: this.db.prepare(this.sql).all(...this.args) }; }
    async first() { await tick(); return this.db.prepare(this.sql).get(...this.args) ?? null; }
    async run() { await tick(); this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

// Real D1 calls are async, so yield like a network round trip would.
const tick = () => new Promise((r) => setImmediate(r));

class FakeD1 {
    constructor() { this.db = new DatabaseSync(":memory:"); }
    prepare(sql) { return new Statement(this.db, sql); }
    async batch(statements) {  // atomic, like D1
        await tick();
        this.db.exec("BEGIN");
        try {
            for (const s of statements) this.db.prepare(s.sql).run(...s.args);
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
        return statements.map(() => ({ success: true }));
    }
}

let env;
beforeEach(() => {
    env = { DB: new FakeD1(), ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) } };
});

const call = (path, init) => worker.fetch(new Request("https://test.local" + path, init), env);
const getJson = async (path) => (await call(path)).json();
const post = (body) => call("/api/bookings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
});

// ---------------------------------------------------------------- helpers

const TODAY = today();
const TOMORROW = addDays(TODAY, 1);
const TUE = 1, WED = 2;
function nextWeekday(day, notToday = false) {
    let d = addDays(TODAY, (day - weekday(TODAY) + 7) % 7);
    if (notToday && d === TODAY) d = addDays(d, 7);
    return d;
}

function booking(overrides = {}) {
    return {
        trip_id: "roble-ceb-hil-2100", // daily, carries motorcycles/cars/SUVs
        date: TOMORROW,
        fare_class: "Economy",
        passengers: [{ name: "Juan Dela Cruz", type: "regular" }, { name: "Ana Reyes", type: "student" }],
        vehicles: [],
        email: "juan@example.com",
        payment_method: "gcash",
        ...overrides,
    };
}

async function availability(tripId = "roble-ceb-hil-2100", day = TOMORROW) {
    const body = await getJson(`/api/availability?date=${day}`);
    return body.sailings.find((s) => s.id === tripId).availability;
}

// ------------------------------------------------------------------ pages

describe("pages", () => {
    test("static pages pass through to assets", async () => {
        assert.equal(await (await call("/schedules")).text(), "asset /schedules");
        assert.equal(await (await call("/my-trip")).text(), "asset /my-trip");
    });

    test("unknown API route is a JSON 404", async () => {
        const resp = await call("/api/nope");
        assert.equal(resp.status, 404);
        assert.equal((await resp.json()).error, "Not found.");
    });

    test("lookup redirects and handles missing references", async () => {
        const { reference } = await (await post(booking())).json();
        const resp = await call(`/my-trip?ref=${reference.slice(3).toLowerCase()}`);
        assert.equal(resp.status, 302);
        assert.ok(resp.headers.get("Location").endsWith(`/booking/${reference}`));

        const missing = await call("/booking/BG-NOPE00");
        assert.equal(missing.status, 404);
        const html = await missing.text();
        assert.match(html, /couldn't find a booking with reference <strong>BG-NOPE00<\/strong>/);
        assert.doesNotMatch(html, /BG-ZZZZZZ/);
    });

    test("missing reference is escaped", async () => {
        const html = await (await call("/booking/%3Cscript%3E")).text();
        assert.ok(html.includes("&lt;script&gt;") && !html.includes("<script>alert"));
    });
});

// ------------------------------------------------------------------ search

describe("search API", () => {
    test("routes", async () => {
        const body = await getJson("/api/routes");
        assert.ok(body.routes.cebu.includes("ormoc"));
        assert.ok(body.routes.hilongos.includes("ubay"));
        assert.ok(!body.vehicle_routes.hilongos.includes("ubay")); // only fast craft run Hilongos -> Ubay
    });

    test("search returns availability", async () => {
        const body = await getJson(`/api/trips?origin=cebu&destination=ormoc&date=${TOMORROW}`);
        assert.ok(body.trips.length);
        const a = body.trips[0].availability;
        assert.equal(a.seats_left, a.seats_total);
        assert.ok(a.seats.every((s) => s.capacity === 10));
    });

    test("search filters by weekday", async () => {
        const tue = nextWeekday(TUE);
        const body = await getJson(`/api/trips?origin=cebu&destination=baybay&date=${tue}`);
        assert.deepEqual(body.trips.map((t) => t.id), ["lapulapu-ceb-bay-2000"]);
        assert.deepEqual(body.other_days.map((t) => t.id), ["roble-ceb-bay-2100"]);
    });

    test("vehicle mode hides sailings without vehicles", async () => {
        const body = await getJson("/api/trips?origin=cebu&destination=ormoc&mode=vehicle");
        assert.ok(body.trips.length && body.trips.every((t) => t.carries_vehicles));
    });

    test("search rejects bad input", async () => {
        assert.equal((await call("/api/trips?origin=cebu&destination=mars")).status, 400);
        assert.equal((await call("/api/trips?origin=cebu&destination=cebu")).status, 400);
        assert.equal((await call("/api/trips?origin=cebu&destination=ormoc&date=2026-02-30")).status, 400);
    });

    test("cancelled sailing shows and has no seats", async () => {
        const wed = nextWeekday(WED);
        const body = await getJson(`/api/trips?origin=cebu&destination=hilongos&date=${wed}`);
        const gloria = body.trips.find((t) => t.id === "gabisan-ceb-hil-1400");
        assert.equal(gloria.availability.status.status, "cancelled");
        assert.equal(gloria.availability.status.bookable, false);
        assert.equal(gloria.availability.seats_left, 0);
    });

    test("dashboard totals", async () => {
        const body = await getJson(`/api/availability?date=${TOMORROW}&origin=cebu&destination=ormoc`);
        assert.equal(body.totals.sailings, 4);
        assert.equal(body.sailings.length, 4);
        assert.equal(body.totals.seats_total, body.sailings.reduce((n, s) => n + s.availability.seats_total, 0));
        assert.ok(!Number.isNaN(Date.parse(body.generated_at)));
    });

    test("dashboard totals ignore cancelled sailings", async () => {
        const body = await getJson(`/api/availability?date=${nextWeekday(WED)}&origin=cebu&destination=hilongos`);
        assert.equal(body.totals.cancelled, 1);
        assert.equal(body.totals.seats_total, 40); // only Roble's 4 classes x 10
    });
});

// ---------------------------------------------------------------- bookings

describe("bookings", () => {
    test("multi-ticket booking and ticket page", async () => {
        const resp = await post(booking({ vehicles: [{ type: "Car", plate: "abc 1234", cargo: "Balikbayan boxes" }] }));
        assert.equal(resp.status, 201);
        const body = await resp.json();
        assert.equal(body.tickets, 3);
        assert.equal(body.total, 461 + 369 + 2000 + 2 * 20 + 50);

        const page = await call(body.url);
        assert.equal(page.status, 200);
        const html = await page.text();
        for (const text of [body.reference, "Juan Dela Cruz", "Ana Reyes", "ABC 1234", "Balikbayan boxes",
            "Ticket 2 of 2", "-03", "Nothing was charged", `<title>Booking ${body.reference} | Bugsay</title>`,
            "₱2,920"]) {
            assert.ok(html.includes(text), text);
        }
    });

    test("vehicle-only freight booking", async () => {
        const resp = await post(booking({
            trip_id: "lapulapu-ceb-bay-2000", date: nextWeekday(TUE), fare_class: null, passengers: [],
            vehicles: [{ type: "Truck", plate: "LAB-9876", cargo: "Copra" }], payment_method: "counter",
        }));
        assert.equal(resp.status, 201);
        assert.equal((await resp.json()).total, 4000 + 50);
    });

    test("booking reduces availability", async () => {
        await post(booking({ vehicles: [{ type: "Motorcycle", plate: "123ABC" }] }));
        const a = await availability();
        const seats = Object.fromEntries(a.seats.map((s) => [s.type, s.left]));
        const slots = Object.fromEntries(a.vehicles.map((v) => [v.type, v.left]));
        assert.equal(seats.Economy, 8);
        assert.equal(seats.Cabin, 10);
        assert.equal(slots.Motorcycle, 9);
        assert.equal(a.seats_left, a.seats_total - 2);
        const other = await availability(undefined, addDays(TODAY, 2));
        assert.equal(other.seats_left, other.seats_total);
    });

    test("cannot overbook a class", async () => {
        const ten = Array.from({ length: 10 }, (_, i) => ({ name: `Passenger ${i}`, type: "regular" }));
        assert.equal((await post(booking({ passengers: ten }))).status, 201);
        const resp = await post(booking({ passengers: ten.slice(0, 1) }));
        assert.equal(resp.status, 409);
        const body = await resp.json();
        assert.match(body.errors.fare_class, /sold out/);
        assert.equal(body.availability.seats[0].left, 0);
    });

    test("cannot overbook vehicle slots", async () => {
        for (let i = 0; i < 2; i++) {
            const cars = Array.from({ length: 5 }, (_, j) => ({ type: "Car", plate: `CAR${i}${j}00` }));
            assert.equal((await post(booking({ passengers: [], vehicles: cars }))).status, 201);
        }
        const resp = await post(booking({ passengers: [], vehicles: [{ type: "Car", plate: "ZZZ999" }] }));
        assert.equal(resp.status, 409);
        assert.match((await resp.json()).errors.vehicles, /Car/);
    });

    test("two people racing for the last seats can't both get them", async () => {
        const nine = Array.from({ length: 9 }, (_, i) => ({ name: `Passenger ${i}`, type: "regular" }));
        assert.equal((await post(booking({ passengers: nine }))).status, 201);
        const one = [{ name: "Racer One", type: "regular" }];
        // Both pass the friendly pre-check before either saves; the D1 guard must stop the second.
        const results = await Promise.all([post(booking({ passengers: one })), post(booking({ passengers: one }))]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        assert.equal((await availability()).seats.find((s) => s.type === "Economy").left, 0);
        const rows = env.DB.db.prepare("SELECT COUNT(*) AS n FROM tickets").get().n;
        assert.equal(rows, 10);
        assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM capacity_guard").get().n, 0);
    });

    const cases = [
        [{ trip_id: "nope" }, "trip_id"],
        [{ fare_class: "Penthouse" }, "fare_class"],
        [{ date: "2000-01-01" }, "date"],
        [{ date: addDays(TODAY, 400) }, "date"],
        [{ passengers: [], vehicles: [] }, "passengers"],
        [{ passengers: Array(11).fill({ name: "X", type: "regular" }) }, "passengers"],
        [{ passengers: [{ name: " ", type: "regular" }] }, "passengers.0.name"],
        [{ passengers: [{ name: "Juan", type: "vip" }] }, "passengers.0.type"],
        [{ vehicles: [{ type: "Bus", plate: "ABC123" }] }, "vehicles.0.type"],
        [{ vehicles: [{ type: "Car", plate: "!" }] }, "vehicles.0.plate"],
        [{ vehicles: Array(6).fill({ type: "Car", plate: "A1" }) }, "vehicles"],
        [{ email: "not-an-email" }, "email"],
        [{ payment_method: "bitcoin" }, "payment_method"],
        [{ trip_id: "__proto__" }, "trip_id"],
        [{ payment_method: "toString" }, "payment_method"],
    ];
    for (const [overrides, field] of cases) {
        test(`validation: ${JSON.stringify(overrides).slice(0, 60)} -> ${field}`, async () => {
            const resp = await post(booking(overrides));
            assert.equal(resp.status, 400);
            assert.ok(field in (await resp.json()).errors);
        });
    }

    test("vehicles rejected on fast craft", async () => {
        const resp = await post(booking({
            trip_id: "oceanjet-ceb-orm-0600", fare_class: "Open Air / Business",
            vehicles: [{ type: "Car", plate: "ABC123" }],
        }));
        assert.equal(resp.status, 400);
        assert.match((await resp.json()).errors.vehicles, /doesn't carry vehicles/);
    });

    test("booking rejects a day the trip doesn't run", async () => {
        const resp = await post(booking({ trip_id: "gabisan-ceb-hil-1400", fare_class: "Tourist", date: nextWeekday(TUE, true) }));
        assert.equal(resp.status, 400);
        assert.match((await resp.json()).errors.date, /Daily except Tue/);
    });

    test("booking requires JSON", async () => {
        assert.equal((await post("x")).status, 400);
        assert.equal((await post("[1]")).status, 400);
    });
});
