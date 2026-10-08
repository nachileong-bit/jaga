// src/navigation/prototypeData.ts
// Care-navigation data for the hackathon prototype.
// EVERYTHING here is fictional and carries simulated: true (spec rule 12).
// Prices are never numbers: real clinic fees and CHAS / PG / MG / Healthier SG
// subsidies vary, so the prototype shows "$XX" placeholders only.

export interface ClinicCard {
  simulated: true;
  label: string; // always the visible prototype label
  heading: string;
  clinic: string;
  distance: string;
  slot: string;
  slotTime: string;
  consult: string;
  outOfPocket: string;
}

const LABEL = "PROTOTYPE DATA · SIMULATED";
const CONSULT = "Estimated consultation: $XX before subsidy";
const OOP = "Estimated out-of-pocket: $XX with applicable subsidy";

export const CLINICS: ClinicCard[] = [
  {
    simulated: true,
    label: LABEL,
    heading: "Your Healthier SG clinic",
    clinic: "ABC Family Clinic",
    distance: "8 minutes from home",
    slot: "Tomorrow, 10:30am",
    slotTime: "10:30am",
    consult: CONSULT,
    outOfPocket: OOP,
  },
  {
    simulated: true,
    label: LABEL,
    heading: "Other clinic nearby",
    clinic: "Lakeview Medical Clinic",
    distance: "12 minutes from home",
    slot: "Tomorrow, 2:15pm",
    slotTime: "2:15pm",
    consult: CONSULT,
    outOfPocket: OOP,
  },
  {
    simulated: true,
    label: LABEL,
    heading: "Other clinic nearby",
    clinic: "Greenfield Family Practice",
    distance: "15 minutes from home",
    slot: "Tomorrow, 4:40pm",
    slotTime: "4:40pm",
    consult: CONSULT,
    outOfPocket: OOP,
  },
];
