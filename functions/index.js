/* eslint-disable require-jsdoc */
const {createHash} = require("node:crypto");
const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {
  FieldValue,
  getFirestore,
} = require("firebase-admin/firestore");

setGlobalOptions({
  maxInstances: 10,
  region: "asia-east1",
});

initializeApp();

const db = getFirestore();

const DATE_CONFIG = {
  "4/12": {
    docId: "4-12",
    label: "4/12（日）",
  },
  "5/2": {
    docId: "5-2",
    label: "5/2（六）",
  },
};

function json(res, status, payload) {
  res.status(status).json(payload);
}

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

function cleanString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseIntSafe(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeDateKey(rawDateKey) {
  const dateKey = cleanString(rawDateKey);
  if (DATE_CONFIG[dateKey]) {
    return dateKey;
  }

  if (dateKey === "4-12") {
    return "4/12";
  }

  if (dateKey === "5-2") {
    return "5/2";
  }

  throw new Error("Unsupported dateKey");
}

function eventDoc(dateKey) {
  return db.collection("events").doc(DATE_CONFIG[dateKey].docId);
}

function participantsCollection(dateKey) {
  return eventDoc(dateKey).collection("participants");
}

function participantId(dateKey, name) {
  return "p_" + createHash("sha1")
      .update(`${dateKey}:${cleanString(name)}`)
      .digest("hex")
      .slice(0, 24);
}

function participantDoc(dateKey, name) {
  return participantsCollection(dateKey).doc(participantId(dateKey, name));
}

function defaultResponseData() {
  return {
    "4/12": {
      date: DATE_CONFIG["4/12"].label,
      people: [],
    },
    "5/2": {
      date: DATE_CONFIG["5/2"].label,
      people: [],
    },
  };
}

function isMealOnly(note) {
  return cleanString(note).includes("只吃飯");
}

function normalizeTransport(value) {
  const transport = cleanString(value);
  if (transport === "driver" || transport === "rider") {
    return transport;
  }
  return "";
}

function normalizeBus(value) {
  const bus = cleanString(value);
  if (bus === "1" || bus === "2") {
    return bus;
  }
  return "";
}

function normalizeParticipant(data) {
  const note = cleanString(data.note);
  const transport = normalizeTransport(data.transport);
  const seats = transport === "driver" ?
    clamp(parseIntSafe(data.seats, 4), 2, 8) :
    0;

  return {
    name: cleanString(data.name),
    count: Math.max(parseIntSafe(data.count, 1), 1),
    note: note,
    transport: transport,
    seats: seats,
    from: transport ? cleanString(data.from) : "",
    ride_with: cleanString(data.ride_with),
    bus: normalizeBus(data.bus),
    createdAtMs: parseIntSafe(data.createdAtMs, 0),
    updatedAtMs: parseIntSafe(data.updatedAtMs, 0),
  };
}

function toStoredParticipant(existing, input, id) {
  const now = Date.now();
  const createdAtMs = existing && existing.createdAtMs ?
    existing.createdAtMs :
    now;

  const rideWith = existing ? cleanString(existing.ride_with) : "";
  const bus = existing ? normalizeBus(existing.bus) : "";

  return {
    name: input.name,
    count: input.count,
    note: input.note,
    transport: input.transport,
    seats: input.seats,
    from: input.from,
    participant_id: id,
    ride_with: rideWith,
    bus: bus,
    createdAtMs: createdAtMs,
    updatedAtMs: now,
    createdAt: existing && existing.createdAt ?
      existing.createdAt :
      FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function toApiParticipant(doc) {
  const data = normalizeParticipant(doc.data() || {});
  return {
    name: data.name,
    count: data.count,
    note: data.note,
    transport: data.transport,
    seats: data.seats,
    from: data.from,
    ride_with: data.ride_with,
    bus: data.bus,
  };
}

function participantSort(a, b) {
  const aTime = a.createdAtMs || 0;
  const bTime = b.createdAtMs || 0;

  if (aTime !== bTime) {
    return aTime - bTime;
  }

  return a.name.localeCompare(b.name, "zh-Hant");
}

async function buildListResponse() {
  const response = defaultResponseData();

  await Promise.all(Object.keys(DATE_CONFIG).map(async (dateKey) => {
    const snapshot = await participantsCollection(dateKey).get();
    const people = snapshot.docs.map((doc) => {
      const participant = toApiParticipant(doc);
      const raw = doc.data() || {};
      participant.createdAtMs = parseIntSafe(raw.createdAtMs, 0);
      return participant;
    });

    people.sort(participantSort);
    response[dateKey].people = people.map((person) => ({
      name: person.name,
      count: person.count,
      note: person.note,
      transport: person.transport,
      seats: person.seats,
      from: person.from,
      ride_with: person.ride_with,
      bus: person.bus,
    }));
  }));

  return response;
}

async function listAction() {
  return buildListResponse();
}

async function addAction(query) {
  const dateKey = normalizeDateKey(query.dateKey);
  const name = cleanString(query.name);

  if (!name) {
    throw new Error("Name is required");
  }

  const input = normalizeParticipant({
    name: name,
    count: query.count,
    note: query.note,
    transport: query.transport,
    seats: query.seats,
    from: query.from,
  });

  await db.runTransaction(async (tx) => {
    const ref = participantDoc(dateKey, name);
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : null;
    tx.set(ref, toStoredParticipant(existing, input, ref.id));
  });

  return {
    ok: true,
    data: await buildListResponse(),
  };
}

async function removeAction(query) {
  const dateKey = normalizeDateKey(query.dateKey);
  const name = cleanString(query.name);

  if (!name) {
    throw new Error("Name is required");
  }

  await db.runTransaction(async (tx) => {
    const ref = participantDoc(dateKey, name);
    const snap = await tx.get(ref);

    if (!snap.exists) {
      return;
    }

    const passengers = await tx.get(
        participantsCollection(dateKey).where("ride_with", "==", name),
    );

    passengers.docs.forEach((doc) => {
      tx.update(doc.ref, {
        ride_with: "",
        updatedAtMs: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    tx.delete(ref);
  });

  return {
    ok: true,
    data: await buildListResponse(),
  };
}

async function boardAction(query) {
  const dateKey = normalizeDateKey(query.dateKey);
  const riderName = cleanString(query.rider);
  const driverName = cleanString(query.driver);

  if (!riderName || !driverName) {
    throw new Error("Rider and driver are required");
  }

  if (riderName === driverName) {
    throw new Error("Driver cannot board their own car");
  }

  await db.runTransaction(async (tx) => {
    const riderRef = participantDoc(dateKey, riderName);
    const driverRef = participantDoc(dateKey, driverName);

    const riderSnap = await tx.get(riderRef);
    const driverSnap = await tx.get(driverRef);

    if (!riderSnap.exists || !driverSnap.exists) {
      throw new Error("Participant not found");
    }

    const rider = normalizeParticipant(riderSnap.data());
    const driver = normalizeParticipant(driverSnap.data());

    if (driver.transport !== "driver") {
      throw new Error("Selected participant is not a driver");
    }

    if (rider.transport === "driver") {
      throw new Error("Drivers cannot board another car");
    }

    if (rider.ride_with && rider.ride_with !== driverName) {
      throw new Error("Rider is already assigned");
    }

    const passengers = await tx.get(
        participantsCollection(dateKey).where("ride_with", "==", driverName),
    );

    const occupiedSeats = passengers.size + 1;
    if (occupiedSeats >= driver.seats) {
      throw new Error("No seats remaining");
    }

    tx.update(riderRef, {
      transport: "rider",
      ride_with: driverName,
      updatedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    ok: true,
    data: await buildListResponse(),
  };
}

async function unboardAction(query) {
  const dateKey = normalizeDateKey(query.dateKey);
  const riderName = cleanString(query.rider);

  if (!riderName) {
    throw new Error("Rider is required");
  }

  await db.runTransaction(async (tx) => {
    const riderRef = participantDoc(dateKey, riderName);
    const riderSnap = await tx.get(riderRef);

    if (!riderSnap.exists) {
      return;
    }

    tx.update(riderRef, {
      ride_with: "",
      updatedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    ok: true,
    data: await buildListResponse(),
  };
}

async function setBusAction(query) {
  const dateKey = normalizeDateKey(query.dateKey);
  const name = cleanString(query.name);
  const bus = normalizeBus(query.bus);

  if (!name) {
    throw new Error("Name is required");
  }

  await db.runTransaction(async (tx) => {
    const personRef = participantDoc(dateKey, name);
    const personSnap = await tx.get(personRef);

    if (!personSnap.exists) {
      throw new Error("Participant not found");
    }

    const person = normalizeParticipant(personSnap.data());
    const expectedBus = isMealOnly(person.note) ? "2" : "1";

    if (bus && bus !== expectedBus) {
      throw new Error("Invalid bus for participant group");
    }

    if (bus) {
      const allPeople = await tx.get(participantsCollection(dateKey));
      let currentTotal = 0;

      allPeople.docs.forEach((doc) => {
        if (doc.id === personRef.id) {
          return;
        }

        const data = normalizeParticipant(doc.data());
        if (data.bus === bus) {
          currentTotal += data.count;
        }
      });

      if (currentTotal + person.count > 8) {
        throw new Error("Bus is full");
      }
    }

    tx.update(personRef, {
      bus: bus,
      updatedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    ok: true,
    data: await buildListResponse(),
  };
}

exports.api = onRequest({invoker: "public"}, async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const action = cleanString(req.query.action);
    let payload;

    switch (action) {
      case "list":
        payload = await listAction();
        json(res, 200, payload);
        return;

      case "add":
        payload = await addAction(req.query);
        json(res, 200, payload);
        return;

      case "remove":
        payload = await removeAction(req.query);
        json(res, 200, payload);
        return;

      case "board":
        payload = await boardAction(req.query);
        json(res, 200, payload);
        return;

      case "unboard":
        payload = await unboardAction(req.query);
        json(res, 200, payload);
        return;

      case "setbus":
        payload = await setBusAction(req.query);
        json(res, 200, payload);
        return;

      default:
        json(res, 400, {error: "Unsupported action"});
        return;
    }
  } catch (error) {
    logger.error("API request failed", error);
    const message = error instanceof Error ?
      error.message :
      "Unexpected server error";
    json(res, 400, {error: message});
  }
});
