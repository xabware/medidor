import { useContext } from 'react';
import { MedidorContext } from './MedidorContextStore';

export const useMedidor = () => {
  const context = useContext(MedidorContext);
  if (!context) {
    throw new Error('useMedidor must be used within MedidorProvider');
  }
  return context;
};
