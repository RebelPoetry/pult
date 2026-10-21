import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { BRIDGE_VERSION } from '../../shell/src/contract.js'
import { getBridge } from './bridge.js'
import { Console } from './Console.js'

export function App(): ReactElement {
  const { bridge, problem } = useMemo(() => getBridge(BRIDGE_VERSION), [])
  if (!bridge) return <Fatal text={problem ?? 'мост недоступен'} />
  return <Console bridge={bridge} />
}

function Fatal({ text }: { text: string }): ReactElement {
  return (
    <div className="fatal" role="alert">
      <h1>Пульт</h1>
      <p>{text}</p>
    </div>
  )
}
