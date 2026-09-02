"""
Mestre do Pano — sync_stock.py

Lê o Stock.xlsx (folha "Rascunhos") e gera data/products.json + copia as
fotografias associadas a cada produto para images/produtos/<id>/.

O Stock.xlsx NUNCA é alterado por este script — é apenas lido.

Uso:
    python sync_stock.py

Configuração: ver config.json (copiar de config.example.json e editar).
"""

import json
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path

import openpyxl

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config.json"

# Colunas obrigatórias para um produto ser considerado válido.
CAMPOS_OBRIGATORIOS = ["titulo", "preco", "stock"]

# Colunas do Excel que são internas e NUNCA devem ir para o products.json.
CAMPOS_INTERNOS = {"custo"}

EXTENSOES_IMAGEM = {".jpg", ".jpeg", ".png", ".webp"}

# --- Peso (Fase 4: coluna "Peso (g)" já existe no Stock.xlsx) -----------
#
# O proprietário da loja já adicionou a coluna "Peso (g)" ao Stock.xlsx,
# com o peso (em GRAMAS) da unidade vendável de cada produto.
#
# Este script APENAS lê essa coluna. Nunca inventa, estima ou arredonda
# pesos em falta — um produto sem peso válido fica identificado num aviso
# e o campo "weight_g" fica a null no products.json, para o frontend e o
# backend saberem que não devem confiar num peso inexistente.
COLUNA_PESO = "Peso (g)"

# --- Unidades (Fase 5: coluna "Unidades" preenchida manualmente pelo dono) -
#
# Representa quantas unidades físicas estão incluídas numa unidade de venda
# (ex.: "Pack de 5 panos" → Unidades = 5). É a partir desta coluna que o
# preço por unidade é calculado (preco / Unidades) — o próprio site nunca
# inventa nem assume este valor.
COLUNA_UNIDADES = "Unidades"


def resolver_unit_count(dados: dict):
    """
    Lê exclusivamente a coluna 'Unidades' do Excel.

    Devolve (unit_count: int|None, motivo_invalido: str|None).
    unit_count só é devolvido quando o valor é um número inteiro > 0.
    Nunca assume 1 por omissão — um produto sem 'Unidades' válido fica
    identificado num aviso e o campo fica a null no products.json.
    """
    valor = dados.get(COLUNA_UNIDADES)

    if valor is None or str(valor).strip() == "":
        return None, "sem valor"

    texto = str(valor).strip()

    try:
        numero = float(texto.replace(",", "."))
    except (TypeError, ValueError):
        return None, f"valor não numérico ({texto!r})"

    if numero != int(numero):
        return None, f"valor não é um número inteiro ({texto!r})"

    unit_count = int(numero)

    if unit_count <= 0:
        return None, f"valor inválido (<= 0): {texto!r}"

    return unit_count, None


def resolver_peso_g(dados: dict):
    """
    Lê exclusivamente a coluna 'Peso (g)' do Excel.

    Devolve (weight_g: int|None, motivo_invalido: str|None).
    weight_g só é devolvido quando o valor é numérico e > 0.
    """
    valor = dados.get(COLUNA_PESO)

    if valor is None or str(valor).strip() == "":
        return None, "sem valor"

    texto = str(valor).strip()

    # Rejeita texto misturado com números (ex.: "82 gramas") — só aceita
    # algo que seja diretamente conversível para número.
    try:
        numero = float(texto.replace(",", "."))
    except (TypeError, ValueError):
        return None, f"valor não numérico ({texto!r})"

    if numero != int(numero):
        # Excel pode ter, por engano, um valor com casas decimais — grama
        # inteira é o formato esperado; ainda assim aceitamos e arredondamos
        # apenas se for claramente um erro de formatação (ex.: 82.0).
        pass

    peso_g = int(round(numero))

    if peso_g <= 0:
        return None, f"valor inválido (<= 0): {texto!r}"

    return peso_g, None


def carregar_config():
    if not CONFIG_PATH.exists():
        print("ERRO: config.json não encontrado.")
        print(f"Copia 'config.example.json' para 'config.json' em {BASE_DIR} e edita os caminhos.")
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def verificar_ficheiro_disponivel_localmente(caminho: Path):
    """Deteta o caso do OneDrive Files On-Demand (ficheiro só na cloud, não local)."""
    if not caminho.exists():
        print("ERRO:")
        print(f"Stock.xlsx não foi encontrado em: {caminho}")
        print("Confirma o caminho em config.json.")
        sys.exit(1)
    try:
        tamanho = caminho.stat().st_size
        # tenta mesmo ler alguns bytes — um ficheiro "só na cloud" costuma
        # falhar ou devolver 0 bytes até o Windows o materializar.
        with open(caminho, "rb") as f:
            inicio = f.read(4)
        if tamanho == 0 or not inicio:
            raise OSError("ficheiro vazio ou inacessível")
    except OSError:
        print("ERRO:")
        print("Stock.xlsx não está disponível localmente.")
        print("Abra/sincronize o ficheiro através do OneDrive e tente novamente.")
        sys.exit(1)


def slugify(texto: str) -> str:
    """Gera um id simples e estável a partir do título (sem SKU no Excel)."""
    texto = unicodedata.normalize("NFKD", texto)
    texto = texto.encode("ascii", "ignore").decode("ascii")  # remove acentos e emojis
    texto = texto.lower()
    texto = re.sub(r"[^a-z0-9]+", "-", texto)
    return texto.strip("-")


def ler_produtos(caminho_excel: Path, nome_folha: str):
    wb = openpyxl.load_workbook(caminho_excel, data_only=True)
    if nome_folha not in wb.sheetnames:
        print(f"ERRO: a folha '{nome_folha}' não existe no Excel. Folhas encontradas: {wb.sheetnames}")
        sys.exit(1)
    ws = wb[nome_folha]

    linhas = list(ws.iter_rows(values_only=True))
    cabecalho = [str(c).strip() if c else "" for c in linhas[0]]

    produtos_validos = []
    avisos = []
    erros = []
    ids_usados = {}

    for num_linha, linha in enumerate(linhas[1:], start=2):
        dados = dict(zip(cabecalho, linha))
        if all(v is None or str(v).strip() == "" for v in dados.values()):
            continue  # linha vazia, ignorar

        campos_em_falta = [
            campo for campo in CAMPOS_OBRIGATORIOS
            if dados.get(campo) is None or str(dados.get(campo)).strip() == ""
        ]
        if campos_em_falta:
            erros.append(f"Produto na linha {num_linha} não possui: {', '.join(campos_em_falta)}.")
            continue

        titulo = str(dados["titulo"]).strip()
        titulo = re.sub(r"\s+", " ", titulo)

        base_id = slugify(titulo) or f"produto-{num_linha}"
        id_final = base_id
        contador = ids_usados.get(base_id, 0)
        if contador:
            id_final = f"{base_id}-{contador + 1}"
        ids_usados[base_id] = contador + 1

        categoria = (str(dados.get("categoria")) or "").strip() or None
        weight_g, motivo_invalido = resolver_peso_g(dados)
        if weight_g is None:
            avisos.append(
                f"WARNING: Produto '{titulo}' (linha {num_linha}, id {id_final}) não possui "
                f"'{COLUNA_PESO}' válido no Stock.xlsx ({motivo_invalido}). "
                f"weight_g ficará a null — os portes não podem ser calculados para este produto "
                f"até o peso ser corrigido no Excel."
            )

        unit_count, motivo_unidades_invalido = resolver_unit_count(dados)
        if unit_count is None:
            avisos.append(
                f"WARNING: Produto '{titulo}' (linha {num_linha}, id {id_final}) não possui "
                f"'{COLUNA_UNIDADES}' válido no Stock.xlsx ({motivo_unidades_invalido}). "
                f"unit_count ficará a null — o preço por unidade não é mostrado para este "
                f"produto até 'Unidades' ser corrigido no Excel (deve ser um número inteiro "
                f"positivo: 1, 2, 3, ...)."
            )

        produto = {
            "id": id_final,
            "name": titulo,
            "description": (str(dados.get("descricao")) or "").strip(),
            "price": round(float(dados["preco"]), 2),
            "brand": (str(dados.get("marca")) or "").strip() or None,
            "category": categoria,
            "condition": (str(dados.get("estado")) or "").strip() or None,
            "color": (str(dados.get("cor")) or "").strip() or None,
            "material": (str(dados.get("material")) or "").strip() or None,
            "additional_info": (str(dados.get("mensagem_personalizada")) or "").strip() or None,
            "stock": int(dados["stock"]),
            "weight_g": weight_g,
            "unit_count": unit_count,
            "images": [],
            "_pasta_fotos": (str(dados.get("pasta_fotos")) or "").strip(),
        }

        # nunca deixar passar campos internos, mesmo que o nome mude no futuro
        for campo_interno in CAMPOS_INTERNOS:
            produto.pop(campo_interno, None)

        produtos_validos.append(produto)

    return produtos_validos, avisos, erros


def resolver_fotografias(produtos, photos_base_dir: Path, output_images_dir: Path, avisos):
    encontradas = 0
    for produto in produtos:
        pasta_relativa = produto.pop("_pasta_fotos", "")
        if not pasta_relativa:
            avisos.append(f"{produto['id']} → sem pasta de fotografias indicada no Excel.")
            continue

        pasta_relativa_normalizada = pasta_relativa.replace("\\", os.sep)
        pasta_origem = (photos_base_dir / pasta_relativa_normalizada)

        if not pasta_origem.is_dir():
            avisos.append(f"{produto['id']} → fotografia não encontrada (pasta '{pasta_relativa}' não existe).")
            continue

        ficheiros = sorted(
            p for p in pasta_origem.iterdir()
            if p.is_file() and p.suffix.lower() in EXTENSOES_IMAGEM
        )
        if not ficheiros:
            avisos.append(f"{produto['id']} → fotografia não encontrada (pasta '{pasta_relativa}' está vazia).")
            continue

        pasta_destino = output_images_dir / produto["id"]
        pasta_destino.mkdir(parents=True, exist_ok=True)

        imagens_finais = []
        for ficheiro in ficheiros:
            destino = pasta_destino / ficheiro.name
            shutil.copy2(ficheiro, destino)
            imagens_finais.append(f"images/produtos/{produto['id']}/{ficheiro.name}")

        produto["images"] = imagens_finais
        encontradas += 1

    return encontradas


def comparar_com_versao_anterior(produtos_novos, output_json: Path):
    if not output_json.exists():
        return len(produtos_novos), 0, 0
    try:
        with open(output_json, "r", encoding="utf-8") as f:
            anterior = json.load(f)
        produtos_antigos = {p["id"]: p for p in anterior.get("products", [])}
    except (json.JSONDecodeError, KeyError):
        return len(produtos_novos), 0, 0

    ids_novos = {p["id"] for p in produtos_novos}
    novos = sum(1 for p in produtos_novos if p["id"] not in produtos_antigos)
    removidos = sum(1 for id_antigo in produtos_antigos if id_antigo not in ids_novos)
    atualizados = sum(
        1 for p in produtos_novos
        if p["id"] in produtos_antigos and produtos_antigos[p["id"]] != p
    )
    return novos, atualizados, removidos


def main():
    config = carregar_config()
    caminho_excel = Path(config["stock_excel_path"])
    photos_base_dir = Path(config["photos_base_dir"])
    nome_folha = config.get("sheet_name", "Rascunhos")
    output_json = BASE_DIR / config.get("output_json", "data/products.json")
    output_images_dir = BASE_DIR / config.get("output_images_dir", "images/produtos")

    print(f"Lendo {caminho_excel.name}...\n")
    verificar_ficheiro_disponivel_localmente(caminho_excel)

    produtos, avisos, erros = ler_produtos(caminho_excel, nome_folha)
    print(f"Produtos encontrados: {len(produtos)}")

    novos, atualizados, removidos = comparar_com_versao_anterior(produtos, output_json)

    fotos_encontradas = resolver_fotografias(produtos, photos_base_dir, output_images_dir, avisos)

    output_json.parent.mkdir(parents=True, exist_ok=True)
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump({"products": produtos}, f, ensure_ascii=False, indent=2)

    print(f"\nProdutos novos: {novos}")
    print(f"Produtos atualizados: {atualizados}")
    print(f"Produtos removidos: {removidos}")
    print(f"\nFotografias encontradas: {fotos_encontradas}/{len(produtos)}")

    if avisos:
        print("\nAVISOS:")
        for aviso in avisos:
            print(f"  {aviso}")

    if erros:
        print("\nERROS:")
        for erro in erros:
            print(f"  {erro}")

    print(f"\n{output_json.relative_to(BASE_DIR)} atualizado.")
    print("\nSincronização concluída.")


if __name__ == "__main__":
    main()
