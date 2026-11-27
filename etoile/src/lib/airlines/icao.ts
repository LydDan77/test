// IATA airline code -> ICAO airline code, for flight-tracker links (FlightAware wants "ASA1054",
// not "AS1054"). A small, hand-reviewed table of the carriers travelers actually book.
//
// Where it came from: seeded from the `airline-codes` package (OpenFlights data, rows marked
// active), then reviewed row by row. That data stopped being maintained in 2017, so:
//  - rows marked "seed" matched what the package says;
//  - rows marked "hand" were corrected or added by hand, because the package still lists the
//    code's previous holder (XP was "XPTO", MX "Mexicana", ZG "Viva Macau") or has no row at all.
// Carriers that have stopped flying, or whose current code could not be confirmed, are left out
// on purpose: a missing row falls back to the IATA code, which is safe.
//
// There is no authoritative free list (IATA's own is licensed). When a tracker link opens the
// wrong airline, fix the row here.

export type AirlineCodeRow = {
  /** ICAO airline designator: three letters. */
  icao: string;
  /** Where the row came from: the seed data, or a correction by hand. */
  source: "seed" | "hand";
};

export const IATA_TO_ICAO: Readonly<Record<string, AirlineCodeRow>> = {
  // --- United States ---------------------------------------------------------------------------
  AA: { icao: "AAL", source: "seed" }, // American Airlines
  AS: { icao: "ASA", source: "seed" }, // Alaska Airlines
  B6: { icao: "JBU", source: "seed" }, // JetBlue Airways
  DL: { icao: "DAL", source: "seed" }, // Delta Air Lines
  F9: { icao: "FFT", source: "seed" }, // Frontier Airlines
  G4: { icao: "AAY", source: "seed" }, // Allegiant Air
  HA: { icao: "HAL", source: "seed" }, // Hawaiian Airlines
  NK: { icao: "NKS", source: "seed" }, // Spirit Airlines
  SY: { icao: "SCX", source: "seed" }, // Sun Country Airlines
  UA: { icao: "UAL", source: "seed" }, // United Airlines
  WN: { icao: "SWA", source: "seed" }, // Southwest Airlines
  XP: { icao: "VXP", source: "hand" }, // Avelo Airlines (seed still says XPTO)
  MX: { icao: "MXY", source: "hand" }, // Breeze Airways (seed still says Mexicana)
  // Regional carriers that fly for the big ones; their own codes show up on some tickets.
  OO: { icao: "SKW", source: "seed" }, // SkyWest Airlines
  YX: { icao: "RPA", source: "hand" }, // Republic Airways (seed still says Midwest Airlines)
  "9E": { icao: "EDV", source: "hand" }, // Endeavor Air (seed still says Pinnacle)
  MQ: { icao: "ENY", source: "hand" }, // Envoy Air (seed still says American Eagle)
  OH: { icao: "JIA", source: "hand" }, // PSA Airlines (seed still says Comair)
  YV: { icao: "ASH", source: "seed" }, // Mesa Airlines
  QX: { icao: "QXE", source: "seed" }, // Horizon Air
  G7: { icao: "GJS", source: "seed" }, // GoJet Airlines
  ZW: { icao: "AWI", source: "seed" }, // Air Wisconsin
  C5: { icao: "UCA", source: "seed" }, // CommuteAir
  "9K": { icao: "KAP", source: "seed" }, // Cape Air

  // --- Canada ----------------------------------------------------------------------------------
  AC: { icao: "ACA", source: "seed" }, // Air Canada
  WS: { icao: "WJA", source: "seed" }, // WestJet
  TS: { icao: "TSC", source: "seed" }, // Air Transat
  PD: { icao: "POE", source: "seed" }, // Porter Airlines
  F8: { icao: "FLE", source: "hand" }, // Flair Airlines (no seed row)

  // --- Mexico, Central and South America, Caribbean --------------------------------------------
  AM: { icao: "AMX", source: "seed" }, // Aeroméxico
  Y4: { icao: "VOI", source: "seed" }, // Volaris
  VB: { icao: "VIV", source: "hand" }, // Viva (no seed row)
  AV: { icao: "AVA", source: "seed" }, // Avianca
  CM: { icao: "CMP", source: "seed" }, // Copa Airlines
  LA: { icao: "LAN", source: "seed" }, // LATAM Airlines
  G3: { icao: "GLO", source: "seed" }, // GOL
  AD: { icao: "AZU", source: "seed" }, // Azul
  AR: { icao: "ARG", source: "seed" }, // Aerolíneas Argentinas
  JA: { icao: "JAT", source: "hand" }, // JetSMART (seed still says Air Bosna)
  H2: { icao: "SKU", source: "seed" }, // Sky Airline
  BW: { icao: "BWA", source: "seed" }, // Caribbean Airlines
  UP: { icao: "BHS", source: "seed" }, // Bahamasair

  // --- Europe ----------------------------------------------------------------------------------
  BA: { icao: "BAW", source: "seed" }, // British Airways
  VS: { icao: "VIR", source: "seed" }, // Virgin Atlantic
  U2: { icao: "EZY", source: "seed" }, // easyJet
  FR: { icao: "RYR", source: "seed" }, // Ryanair
  LS: { icao: "EXS", source: "seed" }, // Jet2.com
  EI: { icao: "EIN", source: "seed" }, // Aer Lingus
  AF: { icao: "AFR", source: "seed" }, // Air France
  KL: { icao: "KLM", source: "seed" }, // KLM
  LH: { icao: "DLH", source: "seed" }, // Lufthansa (the seed also lists Lufthansa Cargo, GEC)
  LX: { icao: "SWR", source: "seed" }, // Swiss
  OS: { icao: "AUA", source: "seed" }, // Austrian Airlines
  SN: { icao: "BEL", source: "hand" }, // Brussels Airlines (seed says DAT, its code before 2007)
  IB: { icao: "IBE", source: "seed" }, // Iberia
  VY: { icao: "VLG", source: "seed" }, // Vueling
  UX: { icao: "AEA", source: "seed" }, // Air Europa
  TP: { icao: "TAP", source: "seed" }, // TAP Air Portugal
  AZ: { icao: "ITY", source: "seed" }, // ITA Airways
  SK: { icao: "SAS", source: "seed" }, // Scandinavian Airlines
  AY: { icao: "FIN", source: "seed" }, // Finnair
  FI: { icao: "ICE", source: "seed" }, // Icelandair
  LO: { icao: "LOT", source: "seed" }, // LOT Polish Airlines
  OK: { icao: "CSA", source: "seed" }, // Czech Airlines
  TK: { icao: "THY", source: "seed" }, // Turkish Airlines
  A3: { icao: "AEE", source: "seed" }, // Aegean Airlines
  W6: { icao: "WZZ", source: "seed" }, // Wizz Air
  EW: { icao: "EWG", source: "seed" }, // Eurowings
  DE: { icao: "CFG", source: "seed" }, // Condor
  HV: { icao: "TRA", source: "seed" }, // Transavia
  TO: { icao: "TVF", source: "seed" }, // Transavia France
  BT: { icao: "BTI", source: "seed" }, // airBaltic
  RO: { icao: "ROT", source: "seed" }, // TAROM
  JU: { icao: "ASL", source: "seed" }, // Air Serbia
  OU: { icao: "CTN", source: "seed" }, // Croatia Airlines
  PC: { icao: "PGT", source: "seed" }, // Pegasus Airlines
  N0: { icao: "NBT", source: "hand" }, // Norse Atlantic Airways (no seed row)
  B0: { icao: "DJT", source: "hand" }, // La Compagnie (no seed row)

  // --- Middle East and Africa ------------------------------------------------------------------
  EK: { icao: "UAE", source: "seed" }, // Emirates
  QR: { icao: "QTR", source: "seed" }, // Qatar Airways
  EY: { icao: "ETD", source: "seed" }, // Etihad Airways
  SV: { icao: "SVA", source: "seed" }, // Saudia
  LY: { icao: "ELY", source: "seed" }, // El Al
  RJ: { icao: "RJA", source: "seed" }, // Royal Jordanian
  ME: { icao: "MEA", source: "seed" }, // Middle East Airlines
  GF: { icao: "GFA", source: "hand" }, // Gulf Air (seed says GBA)
  WY: { icao: "OMA", source: "seed" }, // Oman Air
  KU: { icao: "KAC", source: "seed" }, // Kuwait Airways
  FZ: { icao: "FDB", source: "seed" }, // flydubai
  G9: { icao: "ABY", source: "seed" }, // Air Arabia
  MS: { icao: "MSR", source: "seed" }, // EgyptAir
  AT: { icao: "RAM", source: "seed" }, // Royal Air Maroc
  ET: { icao: "ETH", source: "seed" }, // Ethiopian Airlines
  KQ: { icao: "KQA", source: "seed" }, // Kenya Airways
  SA: { icao: "SAA", source: "seed" }, // South African Airways
  WB: { icao: "RWD", source: "seed" }, // RwandAir

  // --- Asia and the Pacific --------------------------------------------------------------------
  NH: { icao: "ANA", source: "seed" }, // All Nippon Airways
  JL: { icao: "JAL", source: "seed" }, // Japan Airlines
  ZG: { icao: "TZP", source: "hand" }, // ZIPAIR Tokyo (seed still says Viva Macau)
  MM: { icao: "APJ", source: "hand" }, // Peach (no seed row)
  KE: { icao: "KAL", source: "seed" }, // Korean Air
  OZ: { icao: "AAR", source: "seed" }, // Asiana Airlines
  "7C": { icao: "JJA", source: "seed" }, // Jeju Air
  CX: { icao: "CPA", source: "seed" }, // Cathay Pacific
  HX: { icao: "CRK", source: "seed" }, // Hong Kong Airlines
  CI: { icao: "CAL", source: "seed" }, // China Airlines
  BR: { icao: "EVA", source: "seed" }, // EVA Air
  JX: { icao: "SJX", source: "hand" }, // Starlux Airlines (seed says Jusur airways)
  CA: { icao: "CCA", source: "seed" }, // Air China
  MU: { icao: "CES", source: "seed" }, // China Eastern Airlines
  CZ: { icao: "CSN", source: "seed" }, // China Southern Airlines
  HU: { icao: "CHH", source: "seed" }, // Hainan Airlines
  SQ: { icao: "SIA", source: "seed" }, // Singapore Airlines (the seed also lists its cargo arm, SQC)
  TR: { icao: "TGW", source: "hand" }, // Scoot (no seed row)
  MH: { icao: "MAS", source: "seed" }, // Malaysia Airlines
  AK: { icao: "AXM", source: "seed" }, // AirAsia
  D7: { icao: "XAX", source: "seed" }, // AirAsia X
  TG: { icao: "THA", source: "seed" }, // Thai Airways
  VN: { icao: "HVN", source: "seed" }, // Vietnam Airlines
  VJ: { icao: "VJC", source: "hand" }, // VietJet Air (seed says Royal Air Cambodge)
  PR: { icao: "PAL", source: "seed" }, // Philippine Airlines
  "5J": { icao: "CEB", source: "seed" }, // Cebu Pacific
  GA: { icao: "GIA", source: "seed" }, // Garuda Indonesia
  AI: { icao: "AIC", source: "seed" }, // Air India
  "6E": { icao: "IGO", source: "seed" }, // IndiGo
  UL: { icao: "ALK", source: "seed" }, // SriLankan Airlines
  PK: { icao: "PIA", source: "seed" }, // Pakistan International Airlines
  BG: { icao: "BBC", source: "seed" }, // Biman Bangladesh Airlines
  QF: { icao: "QFA", source: "seed" }, // Qantas
  JQ: { icao: "JST", source: "seed" }, // Jetstar
  VA: { icao: "VOZ", source: "seed" }, // Virgin Australia
  NZ: { icao: "ANZ", source: "seed" }, // Air New Zealand
  FJ: { icao: "FJI", source: "seed" }, // Fiji Airways
};
