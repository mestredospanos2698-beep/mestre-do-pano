"""
Testes para a leitura/validação do peso (coluna "Peso (g)") em sync_stock.py.

Executar com:
    python -m pytest tools/test_sync_stock.py -v
ou, sem pytest instalado:
    python tools/test_sync_stock.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sync_stock import (  # noqa: E402
    resolver_peso_g,
    resolver_unit_count,
    COLUNA_PESO,
    COLUNA_UNIDADES,
)


def test_peso_valido():
    peso, motivo = resolver_peso_g({COLUNA_PESO: 82})
    assert peso == 82
    assert motivo is None


def test_peso_valido_como_texto_numerico():
    peso, motivo = resolver_peso_g({COLUNA_PESO: "125"})
    assert peso == 125
    assert motivo is None


def test_peso_em_falta():
    peso, motivo = resolver_peso_g({COLUNA_PESO: None})
    assert peso is None
    assert motivo is not None


def test_peso_string_vazia():
    peso, motivo = resolver_peso_g({COLUNA_PESO: "   "})
    assert peso is None


def test_peso_texto_invalido():
    peso, motivo = resolver_peso_g({COLUNA_PESO: "abc"})
    assert peso is None
    assert "não numérico" in motivo


def test_peso_texto_com_unidade_invalido():
    peso, motivo = resolver_peso_g({COLUNA_PESO: "82 gramas"})
    assert peso is None


def test_peso_negativo_invalido():
    peso, motivo = resolver_peso_g({COLUNA_PESO: -20})
    assert peso is None
    assert "<= 0" in motivo


def test_peso_zero_invalido():
    peso, motivo = resolver_peso_g({COLUNA_PESO: 0})
    assert peso is None


def test_peso_decimal_arredondado():
    peso, motivo = resolver_peso_g({COLUNA_PESO: 82.4})
    assert peso == 82
    assert motivo is None


def test_coluna_em_falta_no_dicionario():
    peso, motivo = resolver_peso_g({"outra_coluna": 10})
    assert peso is None


# --- Unidades (preço por unidade) -------------------------------------------

def test_unidades_1_valido():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: 1})
    assert unit_count == 1
    assert motivo is None


def test_unidades_maior_que_1_valido():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: 5})
    assert unit_count == 5
    assert motivo is None


def test_unidades_como_texto_numerico():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: "10"})
    assert unit_count == 10
    assert motivo is None


def test_unidades_em_falta():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: None})
    assert unit_count is None
    assert motivo is not None


def test_unidades_string_vazia():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: "   "})
    assert unit_count is None


def test_unidades_zero_invalido():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: 0})
    assert unit_count is None
    assert "<= 0" in motivo


def test_unidades_negativo_invalido():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: -1})
    assert unit_count is None
    assert "<= 0" in motivo


def test_unidades_decimal_invalido():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: 2.5})
    assert unit_count is None
    assert "número inteiro" in motivo


def test_unidades_texto_invalido():
    unit_count, motivo = resolver_unit_count({COLUNA_UNIDADES: "abc"})
    assert unit_count is None
    assert "não numérico" in motivo


def test_unidades_coluna_em_falta_no_dicionario():
    unit_count, motivo = resolver_unit_count({"outra_coluna": 10})
    assert unit_count is None


if __name__ == "__main__":
    testes = [v for k, v in list(globals().items()) if k.startswith("test_")]
    falhou = 0
    for teste in testes:
        try:
            teste()
            print(f"OK   {teste.__name__}")
        except AssertionError as e:
            falhou += 1
            print(f"FAIL {teste.__name__}: {e}")
    print(f"\n{len(testes) - falhou}/{len(testes)} testes passaram.")
    sys.exit(1 if falhou else 0)
