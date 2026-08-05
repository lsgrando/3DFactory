// Fórmula de precificação (mesma lógica usada hoje na planilha da empresa):
//   custoFilamento = (precoPorKg / 1000) * pesoGramas
//   custoEnergia   = (potenciaW * tempoHoras / 1000) * tarifaKwh
//   custoTotal     = custoFilamento + custoEnergia
//   precoVenda     = custoTotal * (1 + margemPercentual / 100)   [ou custoTotal + margemFixa]

function calcularPrecificacao({ pesoGramas, tempoHoras, precoPorKg, potenciaW, tarifaKwh, margemPercentual, margemFixa }) {
  const custoFilamento = (Number(precoPorKg) / 1000) * Number(pesoGramas || 0);
  const custoEnergia = ((Number(potenciaW || 0) * Number(tempoHoras || 0)) / 1000) * Number(tarifaKwh || 0);
  const custoTotal = custoFilamento + custoEnergia;

  let precoVenda;
  if (margemFixa !== undefined && margemFixa !== null && margemFixa !== '') {
    precoVenda = custoTotal + Number(margemFixa);
  } else {
    precoVenda = custoTotal * (1 + Number(margemPercentual || 0) / 100);
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    custoFilamento: round2(custoFilamento),
    custoEnergia: round2(custoEnergia),
    custoTotal: round2(custoTotal),
    precoVenda: round2(precoVenda)
  };
}

module.exports = { calcularPrecificacao };
