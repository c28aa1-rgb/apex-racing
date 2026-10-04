export const CAR_IDS = ['ferrari-488-gt3', 'mclaren-720s-gt3', 'bugatti-bolide', 'peugeot-9x8', 'celica-gt4', 'porsche-911-gt3', 'porsche-963', 'mazda-787b', 'skyline-r34', 'red-bull-rb19', 'nascar-camry'] as const;
export type CarId = typeof CAR_IDS[number];
export type Drivetrain = 'RWD' | 'AWD';

export type CarStats = {
  acceleration: number;
  topSpeed: number;
  turning: number;
  braking: number;
};

export type CarPhysics = {
  massKg: number;
  zeroToHundred: number;
  topSpeedKph: number;
  brakeDistance: number;
  drivetrain: Drivetrain;
  steerAngle: number;
  grip: number;
  sideGrip: number;
  driftGrip: number;
  driftBrake: number;
  drag: number;
  downforce: number;
};

export type CarDimensions = {
  lengthM: number;
  bodyWidthM: number;
  heightM: number;
  wheelbaseM: number;
  trackM: number;
  wheelRadiusM: number;
};

export type CarDefinition = {
  id: CarId;
  name: string;
  shortName: string;
  discipline: string;
  description: string;
  model: string;
  dimensions: CarDimensions;
  stats: CarStats;
  physics: CarPhysics;
};

export const CARS: readonly CarDefinition[] = [
  {
    id: 'red-bull-rb19', name: '2023 Oracle Red Bull RB19', shortName: 'Red Bull RB19', discipline: 'Formula · game setup',
    description: 'An open-wheel flagship with a sharp turbo-hybrid voice and immense cornering grip. Performance is tuned for the game.',
    model: 'oracle_red_bull_f1_car_rb19_2023.glb',
    dimensions: { lengthM: 5.63, bodyWidthM: 2, heightM: .95, wheelbaseM: 3.60, trackM: 1.65, wheelRadiusM: .36 },
    stats: { acceleration: 98, topSpeed: 96, turning: 100, braking: 100 },
    physics: { massKg: 800, zeroToHundred: 2.6, topSpeedKph: 350, brakeDistance: 31, drivetrain: 'RWD', steerAngle: .36, grip: 7, sideGrip: 3, driftGrip: 1.3, driftBrake: 29, drag: .62, downforce: 1.3 }
  },
  {
    id: 'nascar-camry', name: '2015 NASCAR Toyota Camry', shortName: 'NASCAR Camry', discipline: 'Stock car · game setup',
    description: 'A thunderous V8 stock car with a long wheelbase and strong straight-line pace. Performance is tuned for the game.',
    model: '2015_nascar_toyota_camry.glb',
    dimensions: { lengthM: 5.08, bodyWidthM: 1.95, heightM: 1.37, wheelbaseM: 2.79, trackM: 1.62, wheelRadiusM: .36 },
    stats: { acceleration: 83, topSpeed: 90, turning: 82, braking: 80 },
    physics: { massKg: 1497, zeroToHundred: 3.6, topSpeedKph: 330, brakeDistance: 33, drivetrain: 'RWD', steerAngle: .35, grip: 6.2, sideGrip: 2.6, driftGrip: 1.5, driftBrake: 25, drag: .55, downforce: .4 }
  },
  {
    id: 'ferrari-488-gt3', name: '2018 Ferrari 488 GT3', shortName: 'Ferrari 488 GT3', discipline: 'GT3 · game setup',
    description: 'A balanced mid-engine racer with progressive turn-in and strong braking. Ratings are game tuning estimates.',
    model: '2018_ferrari_488_gt3.glb',
    dimensions: { lengthM: 4.60, bodyWidthM: 2.04, heightM: 1.22, wheelbaseM: 2.65, trackM: 1.67, wheelRadiusM: .34 },
    stats: { acceleration: 85, topSpeed: 80, turning: 92, braking: 92 },
    physics: { massKg: 1260, zeroToHundred: 3.2, topSpeedKph: 300, brakeDistance: 29, drivetrain: 'RWD', steerAngle: .34, grip: 6.4, sideGrip: 2.6, driftGrip: 1.45, driftBrake: 26, drag: .53, downforce: .78 }
  },
  {
    id: 'mclaren-720s-gt3', name: '2019 McLaren 720S GT3', shortName: 'McLaren 720S GT3', discipline: 'GT3 · game setup',
    description: 'Stable aero and a light response, tuned for flowing corners. Ratings are game tuning estimates.',
    model: '2019_mclaren_720s_gt3.glb',
    dimensions: { lengthM: 4.72, bodyWidthM: 2.04, heightM: 1.20, wheelbaseM: 2.67, trackM: 1.68, wheelRadiusM: .34 },
    stats: { acceleration: 87, topSpeed: 83, turning: 93, braking: 93 },
    physics: { massKg: 1280, zeroToHundred: 3.1, topSpeedKph: 310, brakeDistance: 28, drivetrain: 'RWD', steerAngle: .33, grip: 6.5, sideGrip: 2.65, driftGrip: 1.4, driftBrake: 26, drag: .50, downforce: .82 }
  },
  {
    id: 'bugatti-bolide', name: '2020 Bugatti Bolide Concept', shortName: 'Bugatti Bolide', discipline: 'Concept · game setup',
    description: 'An extreme all-wheel-drive concept with a deliberately progressive steering setup. Performance is a playable estimate, not a measured specification.',
    model: '2020_bugatti_bolide_concept.glb',
    dimensions: { lengthM: 4.76, bodyWidthM: 1.998, heightM: .995, wheelbaseM: 2.75, trackM: 1.65, wheelRadiusM: .35 },
    stats: { acceleration: 99, topSpeed: 100, turning: 90, braking: 96 },
    physics: { massKg: 1240, zeroToHundred: 2.2, topSpeedKph: 380, brakeDistance: 27, drivetrain: 'AWD', steerAngle: .30, grip: 6.6, sideGrip: 2.75, driftGrip: 1.4, driftBrake: 28, drag: .64, downforce: 1.1 }
  },
  {
    id: 'peugeot-9x8', name: '2024 Peugeot 9X8', shortName: 'Peugeot 9X8', discipline: 'LMH · game setup',
    description: 'A planted hybrid prototype tuned for fast, committed corners. Ratings are game tuning estimates.',
    model: '2024_peugeot_9x8_hybrid_hypercar_lmh.glb',
    dimensions: { lengthM: 4.995, bodyWidthM: 2, heightM: 1.145, wheelbaseM: 3.045, trackM: 1.65, wheelRadiusM: .35 },
    stats: { acceleration: 94, topSpeed: 93, turning: 95, braking: 97 },
    physics: { massKg: 1030, zeroToHundred: 2.9, topSpeedKph: 338, brakeDistance: 27.5, drivetrain: 'AWD', steerAngle: .33, grip: 6.75, sideGrip: 2.8, driftGrip: 1.4, driftBrake: 29, drag: .63, downforce: 1.15 }
  },
  {
    id: 'celica-gt4', name: 'Toyota Celica GT-Four', shortName: 'Celica GT-Four', discipline: 'Group A rally',
    description: 'The forgiving choice. All-wheel drive and generous steering lock make it composed on corner entry and easy to recover.',
    model: 'toyota_celica_gt4_rally.glb',
    dimensions: { lengthM: 4.42, bodyWidthM: 1.75, heightM: 1.31, wheelbaseM: 2.54, trackM: 1.51, wheelRadiusM: .32 },
    stats: { acceleration: 65, topSpeed: 62, turning: 88, braking: 69 },
    physics: { massKg: 1200, zeroToHundred: 5.9, topSpeedKph: 245, brakeDistance: 39, drivetrain: 'AWD', steerAngle: .39, grip: 5.9, sideGrip: 2.45, driftGrip: 1.55, driftBrake: 22, drag: .56, downforce: .16 }
  },
  {
    id: 'porsche-911-gt3', name: 'Porsche 911 GT3', shortName: '911 GT3', discipline: 'Road-legal track car',
    description: 'A precise all-rounder with strong braking and rear-drive rotation. It rewards a clean release of the brake pedal.',
    model: 'porsche_911_gt3.glb',
    dimensions: { lengthM: 4.55, bodyWidthM: 1.85, heightM: 1.28, wheelbaseM: 2.46, trackM: 1.58, wheelRadiusM: .34 },
    stats: { acceleration: 83, topSpeed: 86, turning: 89, braking: 91 },
    physics: { massKg: 1435, zeroToHundred: 3.4, topSpeedKph: 318, brakeDistance: 30, drivetrain: 'RWD', steerAngle: .35, grip: 6.15, sideGrip: 2.55, driftGrip: 1.45, driftBrake: 25, drag: .42, downforce: .38 }
  },
  {
    id: 'porsche-963', name: '2023 Porsche 963', shortName: 'Porsche 963', discipline: 'LMDh prototype',
    description: 'The quickest point-to-point machine here. Huge downforce and braking performance arrive with very sharp responses.',
    model: '2023_porsche_963_lmdh_racecar_no.5.glb',
    dimensions: { lengthM: 5.10, bodyWidthM: 2, heightM: 1.06, wheelbaseM: 3.15, trackM: 1.68, wheelRadiusM: .34 },
    stats: { acceleration: 96, topSpeed: 95, turning: 96, braking: 98 },
    physics: { massKg: 1030, zeroToHundred: 2.8, topSpeedKph: 345, brakeDistance: 27, drivetrain: 'RWD', steerAngle: .36, grip: 6.8, sideGrip: 2.9, driftGrip: 1.3, driftBrake: 29, drag: .62, downforce: 1.18 }
  },
  {
    id: 'mazda-787b', name: 'Mazda 787B', shortName: 'Mazda 787B', discipline: 'Group C prototype',
    description: 'Light, rapid and alive beneath you. It carries exceptional speed but asks for a measured hand through direction changes.',
    model: 'mazda_787b__www.vecarz.com.glb',
    dimensions: { lengthM: 4.78, bodyWidthM: 1.99, heightM: 1.00, wheelbaseM: 2.66, trackM: 1.63, wheelRadiusM: .33 },
    stats: { acceleration: 90, topSpeed: 93, turning: 92, braking: 94 },
    physics: { massKg: 830, zeroToHundred: 3.1, topSpeedKph: 338, brakeDistance: 29, drivetrain: 'RWD', steerAngle: .35, grip: 6.45, sideGrip: 2.7, driftGrip: 1.25, driftBrake: 27, drag: .58, downforce: .92 }
  },
  {
    id: 'skyline-r34', name: '1999 Nissan Skyline GT-R', shortName: 'Skyline GT-R', discipline: 'Tuned street',
    description: 'Stable under power and confidence-inspiring on exits. Its mass is real, but all-wheel drive makes the throttle easy to trust.',
    model: '1999_nissan_skyline_gtr_r34_c-west__2f2f.glb',
    dimensions: { lengthM: 4.60, bodyWidthM: 1.79, heightM: 1.36, wheelbaseM: 2.67, trackM: 1.49, wheelRadiusM: .33 },
    stats: { acceleration: 86, topSpeed: 81, turning: 78, braking: 79 },
    physics: { massKg: 1560, zeroToHundred: 3.9, topSpeedKph: 300, brakeDistance: 33, drivetrain: 'AWD', steerAngle: .34, grip: 5.7, sideGrip: 2.35, driftGrip: 1.5, driftBrake: 24, drag: .5, downforce: .22 }
  }
] as const;

export const DEFAULT_CAR = CARS.find(car => car.id === 'porsche-911-gt3')!;
export const carById = (id: string | undefined): CarDefinition => CARS.find(car => car.id === id) ?? DEFAULT_CAR;
