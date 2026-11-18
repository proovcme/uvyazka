# Связь с ru-aec

Методическая база — отдельный репозиторий
[ru-aec-skills](https://github.com/proovcme/ru-aec-skills/tree/c88dedfaab63e836a72383a6552e94c6d9646334).
Ревизия c88dedfaab63e836a72383a6552e94c6d9646334 закрепляет происхождение,
а не актуальность нормативов на дату выпуска. Перед нормативным выводом проверь
действующие первоисточники и поправки по процедуре профильного навыка.
Локальные уточнения заказчика применяются в его проекте, не публикуются с кодом.

| Задача | Методика ru-aec | Доступная операция Увязки |
|---|---|---|
| ЭОМ: нагрузки, ток, линия | [Нагрузки и цепи](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/electrical-calculate-loads-and-circuits/SKILL.md) | sum_products, electrical_current, voltage_drop |
| Пожарка: питание, оповещение | [СПС, СОУЭ, автоматика](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/fire-design-detection-and-automation/SKILL.md) | sum_products, battery_charge, sound_level |
| Теплоноситель, потери участка | [Водяное отопление](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/hvac-design-hydronic-heating/SKILL.md), [Гидравлика ВК](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/plumbing-size-and-select-equipment/SKILL.md) | liquid_heat_flow, pipe_pressure_loss |
| Геометрия защищаемой зоны | [Пожаротушение](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/fire-design-suppression/SKILL.md) | enclosure_geometry; масса вещества и динамика не считаются |
| Проверка результатов освещения | [Освещение](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/electrical-design-lighting/SKILL.md) | lighting_uniformity по готовым min/mean/max |
| СКС: портовая ёмкость, выдача | [Комплектование инженерной выдачи](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/fire-electrical-issue-documentation/SKILL.md) | port_budget; трафик, PoE и uplink требуют отдельного расчёта |
| Листы, графика, основная надпись, УГО | [ЕСКД/СПДС](https://github.com/proovcme/ru-aec-skills/blob/c88dedfaab63e836a72383a6552e94c6d9646334/apply-eskd-spds-to-drawings/SKILL.md) | build_engineering_document, check_engineering_document в объявленных границах |

Формулы ядра реализованы в Увязке и проверяются синтетическими тестами.
Ссылки на навыки задают инженерный процесс; они не подтверждают каждую формулу
и не заменяют стандарт, паспорт производителя или профильный расчётный комплекс.
Тексты стандартов и проектные документы в этот мост не включены.
