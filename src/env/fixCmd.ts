// Починка-команда доктора: одна строка и для `pult doctor`, и для кнопки «копировать» в окне
// (окно рисует кнопку только по fixCmd). Отдельный крошечный модуль, а не экспорт из env/doctor.ts:
// его берут пункты службы в потоке демона (service/doctorWorker) — тянуть туда весь доктор незачем.

export const cmd = (c: string): { fix: string; fixCmd: string } => ({ fix: c, fixCmd: c })
