// /booking/<reference> page content. A port of templates/booking.html: keep the two in step.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const peso = (n) => "₱" + Number(n).toLocaleString("en-US");
const pad2 = (n) => String(n).padStart(2, "0");

/** "2026-11-19" -> "Thu, Nov 19, 2026" (Python strftime('%a, %b %d, %Y')). */
function longDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[dt.getUTCDay()]}, ${months[m - 1]} ${pad2(d)}, ${y}`;
}

export function renderBooking({ tx, trip, ports, passengerTypes, vehicleIcons, payment, discountPct, passengers, vehicles }) {
    const count = passengers.length + vehicles.length;
    const ref = esc(tx.reference);
    const code = (t) => `${ref}-${pad2(t.seq)}`;
    const origin = ports[trip.origin], destination = ports[trip.destination];

    const passengerTickets = passengers.map((t, i) => `
        <article class="ticket" style="--i: ${i + 2}">
            <div class="ticket-top"><span>Ticket ${i + 1} of ${passengers.length}</span><code>${code(t)}</code></div>
            <h3>${esc(t.holder)}</h3>
            <p>${esc(passengerTypes[t.category]?.label ?? t.category)} · ${esc(t.accommodation)}</p>
            <div class="ticket-bottom"><span>Fare${t.discount ? ` (−${discountPct}%)` : ""}</span><b>${peso(t.price - t.discount)}</b></div>
        </article>`).join("");

    const vehicleTickets = vehicles.map((t, i) => `
        <article class="ticket ticket--vehicle" style="--i: ${i + passengers.length + 2}">
            <div class="ticket-top"><span><i class="fa-solid ${esc(vehicleIcons[t.category] || "fa-car")}" aria-hidden="true"></i> ${esc(t.category)}</span><code>${code(t)}</code></div>
            <h3>${esc(t.holder)}</h3>
            <p>${esc(t.cargo || "No cargo declared")}</p>
            <div class="ticket-bottom"><span>Vehicle rate</span><b>${peso(t.price)}</b></div>
        </article>`).join("");

    const paymentNote = payment.online
        ? `the ${esc(payment.label)} payment was simulated. Nothing was charged.`
        : `you chose to pay at the ${esc(trip.company)} counter at ${esc(origin.terminal)}.`;

    return `<div class="wrap page-head section" style="max-width: calc(880px + 2 * var(--gutter))">
    <svg class="confirm-mark" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>
    <p class="eyebrow">Booking confirmed</p>
    <h1 class="title-1">You're all set. <span class="ref-code">${ref}</span></h1>
    <p class="subhead">${count} ticket${count === 1 ? "" : "s"} in one booking. Keep this page or note the reference; you can find it again under <a class="prose-link" href="/my-trip">My trip</a>.</p>

    <div class="notice notice--info" style="margin-top:1.25rem">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        <div><strong>Prototype:</strong> these aren't valid carrier tickets yet, and ${paymentNote}</div>
    </div>

    <article class="ticket-hero">
        <div class="ticket-route">
            <div><span>From</span><h2>${esc(trip.origin_name)}</h2><p>${esc(origin.terminal)}</p></div>
            <i class="fa-solid fa-ship" aria-hidden="true"></i>
            <div class="right"><span>To</span><h2>${esc(trip.destination_name)}</h2><p>${esc(destination.terminal)}</p></div>
        </div>
        <dl class="kv">
            <div><dt>Date</dt><dd>${longDate(tx.travel_date)}</dd></div>
            <div><dt>Departs</dt><dd>${esc(trip.depart_label)}</dd></div>
            <div><dt>Arrives</dt><dd>${esc(trip.arrive_label)}${trip.next_day ? " (next day)" : ""}</dd></div>
            <div><dt>Carrier</dt><dd>${esc(trip.company)}${trip.vessel ? ` · ${esc(trip.vessel)}` : ""}</dd></div>
            <div><dt>Payment</dt><dd>${esc(payment.label)}${payment.online ? " (demo)" : ""}</dd></div>
            <div><dt>Total</dt><dd class="tabular" style="color:var(--primary);font-weight:700">${peso(tx.total)}</dd></div>
        </dl>
    </article>
${passengers.length ? `
    <h2 class="title-3" style="margin-top:2rem">Passenger tickets</h2>
    <div class="tickets">${passengerTickets}
    </div>` : ""}${vehicles.length ? `
    <h2 class="title-3" style="margin-top:2rem">Vehicle tickets</h2>
    <div class="tickets">${vehicleTickets}
    </div>` : ""}

    <h2 class="title-3" style="margin-top:2rem">Payment summary</h2>
    <div class="group-list summary" style="margin-top:0.75rem">
        ${tx.fare_total ? `<div class="line"><span>Passenger fares (${passengers.length} × ${esc(tx.fare_class)})</span><span>${peso(tx.fare_total)}</span></div>` : ""}
        ${tx.discount_total ? `<div class="line discount"><span>Student / senior / PWD discount</span><span>−${peso(tx.discount_total)}</span></div>` : ""}
        ${tx.vehicle_total ? `<div class="line"><span>Vehicles (${vehicles.length})</span><span>${peso(tx.vehicle_total)}</span></div>` : ""}
        <div class="line muted"><span>Bugsay service fee</span><span>${peso(tx.service_fee)}</span></div>
        <div class="line" style="font-weight:700"><span>Total</span><span>${peso(tx.total)}</span></div>
    </div>

    <h2 class="title-3" style="margin-top:2rem">Before you go</h2>
    <ul class="checklist" style="margin-top:0.75rem">
        <li><i class="fa-regular fa-clock" aria-hidden="true"></i> Arrive at the terminal at least an hour before departure${vehicles.length ? ", earlier with a vehicle for loading" : ""}.</li>
        <li><i class="fa-regular fa-id-card" aria-hidden="true"></i> Bring a valid ID for every passenger${tx.discount_total ? ", plus school, senior or PWD ID for discounted fares" : ""}.</li>
        ${vehicles.length ? `<li><i class="fa-solid fa-file-lines" aria-hidden="true"></i> Bring each vehicle's OR/CR, and cargo papers if you're shipping goods.</li>` : ""}
        <li><i class="fa-solid fa-cloud-sun-rain" aria-hidden="true"></i> Check <a href="/updates">travel updates</a> for weather suspensions.</li>
    </ul>

    <div class="button-row">
        <button type="button" class="btn btn-secondary" onclick="window.print()"><i class="fa-solid fa-print" aria-hidden="true"></i> Print tickets</button>
        <a href="/schedules" class="btn btn-primary">Plan another trip</a>
    </div>
</div>`;
}
