// The published test numbers from jkeen/tracking_number_data (MIT licence), as bundled in npm
// ts-tracking-number@1.0.17: 97 valid and invalid numbers across UPS, FedEx, USPS, DHL, Amazon,
// OnTrac and the postal S10 format. Copied without change, spaces included; the reference
// implementation (research/ship-ahead-code/tracking.mjs) passes all 97 and so must the port.

export type TrackingVectorSet = {
  /** The data file the numbers came from. "s10" is the international postal format. */
  courier: "ups" | "fedex" | "usps" | "dhl" | "amazon" | "ontrac" | "s10";
  format: string;
  valid: string[];
  invalid: string[];
};

export const TRACKING_VECTOR_COUNT = 97;

export const TRACKING_VECTORS: TrackingVectorSet[] = [
  {
    courier: "ups",
    format: "UPS",
    valid: ["1Z5R89390357567127","1Z879E930346834440","1Z410E7W0392751591","1Z8V92A70367203024"," 1 Z 8 V 9 2 A 7 0 3 6 7 2 0 3 0 2 4 ","1ZXX3150YW44070023"],
    invalid: ["2Z5R89390357567127","1A5R89390357567127","1Z1111111111111111"],
  },
  {
    courier: "fedex",
    format: "FedEx Express (12)",
    valid: ["986578788855","477179081230","799531274483","790535312317"," 7 9 0 5 3 5 3 1 2 3 1 7 ","974367662710"],
    invalid: ["996578788855"],
  },
  {
    courier: "fedex",
    format: "FedEx Express (34)",
    valid: ["1001921334250001000300779017972697","1001921380360001000300639585804382","1001901781990001000300617767839437"," 1 0 0 1 9 0 1 7 8 1 9 9 0 0 0 1 0 0 0 3 0 0 6 1 7 7 6 7 8 3 9 4 3 7 ","1002297871540001000300790695517286"],
    invalid: ["1001901781990001000300617767839438"],
  },
  {
    courier: "fedex",
    format: "FedEx SmartPost",
    valid: ["61299998820821171811"," 6 1 2 9 9 9 9 8 8 2 0 8 2 1 1 7 1 8 1 1 ","9261292700768711948021"],
    invalid: ["9261292700768711948020"],
  },
  {
    courier: "fedex",
    format: "FedEx Ground",
    valid: ["0414 4176 0228 964","5682 8361 0012 000"," 5 6 8 2   8 3 6 1   0 0 1 2   0 0 0 ","5682 8361 0012 734"],
    invalid: ["5682 8361 0012 732"],
  },
  {
    courier: "fedex",
    format: "FedEx Ground (SSCC-18)",
    valid: ["00 0123 4500 0000 0027"," 0 0   0 1 2 3   4 5 0 0   0 0 0 0   0 0 2 7 "],
    invalid: ["000000000000000001"],
  },
  {
    courier: "fedex",
    format: "FedEx Ground 96 (22)",
    valid: ["9611020987654312345672"," 9 6 1 1 0 2 0 9 8 7 6 5 4 3 1 2 3 4 5 6 7 2 "],
    invalid: ["9600000000000000000001"],
  },
  {
    courier: "fedex",
    format: "FedEx Ground GSN",
    valid: ["9622001900000000000000776632517510","9622001560000000000000794808390594","9622001560001234567100794808390594"," 9 6 2 2 0 0 1 5 6 0 0 0 1 2 3 4 5 6 7 1 0 0 7 9 4 8 0 8 3 9 0 5 9 4 ","9632001560123456789900794808390594"],
    invalid: ["9622001560001234567100794808390595","9622001560001234567100794808390597"],
  },
  {
    courier: "usps",
    format: "USPS 20",
    valid: ["0307 1790 0005 2348 3741"," 0 3 0 7   1 7 9 0   0 0 0 5   2 3 4 8   3 7 4 1 ","7112 3456 7891 2345 6787"],
    invalid: ["0307 1790 0005 2348 3742"],
  },
  {
    courier: "usps",
    format: "USPS 34v2",
    valid: ["4201002334249200190132607600833457","4201028200009261290113185417468510"," 4 2 0 1 0 2 8 2 0 0 0 0 9 2 6 1 2 9 0 1 1 3 1 8 5 4 1 7 4 6 8 5 1 0 "],
    invalid: ["4201028200009261290113185417468511"],
  },
  {
    courier: "usps",
    format: "USPS 91",
    valid: ["420 22153 9101026837331000039521","7196 9010 7560 0307 7385","9505 5110 6960 5048 6006 24","9101 1234 5678 9000 0000 13","92748931507708513018050063","9400 1112 0108 0805 4830 16","9361 2898 7870 0317 6337 95"," 9 3 6 1   2 8 9 8   7 8 7 0   0 3 1 7   6 3 3 7   9 5 ","9405803699300124287899"],
    invalid: ["61299998820821171811","9200000000000000000000","420000000000000000000000000000","420000009200000000000000000000"],
  },
  {
    courier: "dhl",
    format: "DHL Express",
    valid: ["3318810025","8487135506","3318810036"," 3 3 1 8 8 1 0 0 3 6 ","3318810014"],
    invalid: ["3318810010","3318810034","3318810011"],
  },
  {
    courier: "dhl",
    format: "DHL Express Air",
    valid: ["73891051146"," 7 3 8 9 1 0 5 1 1 4 6 "],
    invalid: ["73891051149","73891051147"],
  },
  {
    courier: "amazon",
    format: "Amazon Logistics",
    valid: ["TBA000000000000","TBA010000000000"," T B A 0 0 0 0 0 0 0 0 0 0 0 0 ","TBA502887274000"],
    invalid: ["TBA50288727400A","000000000000000","000000000000","TBB000000000000"],
  },
  {
    courier: "ontrac",
    format: "OnTrac",
    valid: ["C11031500001879"," C 1 1 0 3 1 5 0 0 0 0 1 8 7 9 ","C10999911320231"],
    invalid: ["C10000000000000","C11031500001889"],
  },
  {
    courier: "s10",
    format: "S10",
    valid: ["RB123456785GB","RB123456785US","RB123456785CV","RB123456785CF"," R B 1 2 3 4 5 6 7 8 5 C F "],
    invalid: ["RB123456786US","RB123456785XX"],
  },
];
