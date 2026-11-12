# Trip Booking

Herramienta interna para que los gestores de viajes planifiquen de forma centralizada los viajes de empresa de los empleados. Las reservas reales se hacen fuera, en la plataforma de cada proveedor, a partir de enlaces de búsqueda que genera la aplicación.

Términos canónicos en inglés (código y glosario); la interfaz es bilingüe español/inglés.

## Language

### People and roles

**Travel Manager** (Gestor de viajes):
Único rol de la aplicación: quien planifica los Trips en nombre de los Employees y los reserva fuera.
_Avoid_: Agent, admin, booker

**Employee** (Empleado):
Persona de la empresa dada de alta en la aplicación y susceptible de viajar; se identifica por nombre y email.
_Avoid_: User, person

**Traveller** (Viajero):
Employee en su papel dentro de un Trip concreto.
_Avoid_: Passenger, guest

### Trips

**Trip** (Viaje):
Desplazamiento de empresa de uno o varios Travellers con un mismo propósito, identificado por un nombre.
_Avoid_: Journey, mission, itinerary

**Itinerary type** (Tipo de itinerario):
Forma de los Legs de un Trip: **One-way** (Solo ida), **Return** (Ida y vuelta) o **Multi-city** (Multidestino).
_Avoid_: Trip type, route type

**City** (Ciudad):
Origen o destino de un Leg y lugar de una Stay. Agrupa todos sus aeropuertos y estaciones.
_Avoid_: Airport, station, location

**Leg** (Tramo):
Trayecto de una ciudad a otra en una fecha, dentro de un Trip, con un medio de transporte (tren o avión). Todos los Travellers del Trip hacen los mismos Legs.
_Avoid_: Segment, stage

**Stay** (Estancia):
Periodo de alojamiento en una ciudad, con fecha de entrada y de salida, dentro de un Trip. Se deduce de las fechas de los Legs y el Travel Manager lo puede ajustar o quitar.
_Avoid_: Accommodation, lodging, nights

**Booked mark** (Marca de reservado):
Indicación manual del Travel Manager de que un Leg o una Stay ya se ha reservado fuera de la aplicación. No guarda precio, localizador ni documentos.
_Avoid_: Booking, reservation, confirmation

**Search Link** (Enlace de búsqueda):
Enlace a la búsqueda de un proveedor externo (Skyscanner para vuelos, Trainline para trenes, Booking.com para hoteles) con los datos de un Leg o Stay ya rellenos.
_Avoid_: Option, deep link, quote


### Trip lifecycle

**Planning** (En planificación): el Trip existe y el Travel Manager está buscando y reservando.
**Booked** (Reservado): todos los Legs y Stays del Trip tienen Booked mark.
**Completed** (Realizado): el Travel Manager marca que el Trip ya ha tenido lugar.
**Cancelled** (Cancelado): el Trip no se hará.
_Avoid_: Draft (para el estado del Trip)
