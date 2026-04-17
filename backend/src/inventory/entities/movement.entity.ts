import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from 'typeorm';
import { Lot } from './lot.entity';

export enum MovementType {
  ENTRY = 'ENTRY',
  EXIT = 'EXIT',
  ADJUSTMENT = 'ADJUSTMENT',
}

@Entity('movements')
export class Movement {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    type: 'enum',
    enum: MovementType,
  })
  type: MovementType;

  @Column({ type: 'decimal', precision: 10, scale: 3 })
  quantity: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  reason: string;

  @ManyToOne(() => Lot, (lot) => lot.movements)
  lot: Lot;
}
