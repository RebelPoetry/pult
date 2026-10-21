// Поток-исполнитель пунктов `pult doctor` про службу для демона (см. serviceDoctorItemsAsync).
// Здесь spawnSync launchctl/systemctl/loginctl/`node -v` блокирует только этот поток, а не
// событийный цикл демона.

import { parentPort, workerData } from 'node:worker_threads'
import type { PultPaths } from '../core/paths.js'
import { serviceDoctorItems } from './doctor.js'

const { paths, env } = workerData as { paths: PultPaths; env: NodeJS.ProcessEnv }
parentPort?.postMessage(serviceDoctorItems(paths, env))
